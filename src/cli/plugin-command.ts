import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type { CliOptions } from "./args.ts";
import { pluginsDir } from "../config/paths.ts";
import { describeDeclarativeScan, scanDeclarativePlugins } from "../plugins/declarative.ts";
import { writeStderr, writeStdout } from "./output.ts";

/**
 * 插件管理子命令。
 *
 * add 把三种来源落进插件目录：本地目录直接复制、git 仓库浅克隆、npm 包先装进临时目录再连
 * 依赖一起搬进来。装完统一跑一次扫描，把「装上了什么、哪些不受支持、为什么失败」一次说清。
 *
 * 安全上的两条硬规则：npm 安装一律 `--ignore-scripts`——插件的安装钩子在本进程外执行，不设
 * 防线；来源是用户主动给的，但插件代码会在 reins 进程内运行，装之前必须把这件事说在前面。
 */

export interface CommandRunner {
	(command: string, args: readonly string[], cwd: string): Promise<{
		readonly code: number;
		readonly stderr: string;
	}>;
}

type SourceKind = "local" | "git" | "npm";

export async function runPluginCommand(
	options: CliOptions,
	runner: CommandRunner = execRunner,
	directory: string = pluginsDir(),
): Promise<number> {
	if (options.pluginAction === "list") return list(directory);
	if (options.pluginAction === "add") return add(options.pluginSource!, directory, runner);
	return 2;
}

async function list(directory: string): Promise<number> {
	for (const line of report(directory, { restart: false })) writeStdout(`${line}\n`);
	return 0;
}

async function add(source: string, directory: string, runner: CommandRunner): Promise<number> {
	const kind = detectSource(source);
	const target = join(directory, targetName(source, kind));
	if (existsSync(target)) {
		writeStderr(`reins: plugin directory already exists: ${target}\n`);
		return 1;
	}

	writeStderr(
		"Note: plugin code runs inside the reins process with your OS permissions; only install sources you trust.\n",
	);

	let failure: string | undefined;
	try {
		if (kind === "git") {
			mkdirSync(directory, { recursive: true });
			const clone = await runner("git", ["clone", "--depth", "1", source, target], directory);
			failure = clone.code !== 0 ? `git clone failed: ${clone.stderr.trim() || "unknown error"}` : undefined;
		} else if (kind === "npm") {
			failure = await installNpm(source, target, runner);
		} else {
			failure = installLocal(source, target);
		}
		// npm 来源在临时目录安装时依赖已经就位；本地与 git 来源的依赖现在补装
		if (failure === undefined && kind !== "npm") {
			failure = await installDependencies(target, runner);
		}
	} catch (error) {
		failure = String(error);
	}
	if (failure !== undefined) {
		rmSync(target, { recursive: true, force: true });
		writeStderr(`reins: install failed — ${failure}\n`);
		return 1;
	}

	// 装完立刻扫一次：来源给错了、清单缺字段这类问题当场暴露，而不是等到下次启动
	for (const line of report(directory, { restart: true })) writeStderr(`reins: ${line}\n`);
	return 0;
}

function detectSource(source: string): SourceKind {
	if (isDirectory(source) || isDirectory(resolve(source))) return "local";
	if (/^https?:\/\/\S+\.git$/i.test(source) || /^[\w.-]+@[\w.-]+:.+/.test(source)) return "git";
	return "npm";
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function targetName(source: string, kind: SourceKind): string {
	if (kind === "local") return basename(resolve(source));
	if (kind === "git") {
		const last = source.split(/[/:]/).filter((part) => part.length > 0).at(-1) ?? "plugin";
		return last.replace(/\.git$/i, "");
	}
	// scoped 包名 @scope/pkg 取 pkg；目录名里不放 @，避免 Windows 上的保留字符问题
	return npmPackageName(source).replace(/^@[^/]+\//, "");
}

function installLocal(source: string, target: string): string | undefined {
	const origin = resolve(source);
	if (!isDirectory(origin)) return `not a directory: ${source}`;
	copyPlugin(origin, target);
	return undefined;
}

/** 安装说明里的包名：剥掉版本说明（pkg@1.2、@scope/pkg@1.2 → @scope/pkg）。 */
function npmPackageName(spec: string): string {
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		const tail = spec.slice(slash + 1);
		const at = tail.lastIndexOf("@");
		return `@${spec.slice(1, slash)}/${at > 0 ? tail.slice(0, at) : tail}`;
	}
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}

async function installNpm(packageSource: string, target: string, runner: CommandRunner): Promise<string | undefined> {
	const packageName = npmPackageName(packageSource);
	// 先装进临时目录再搬：插件目录里只留包本身与它的依赖，npm 的中间产物不外带
	const staging = join(tmpdir(), `reins-plugin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	try {
		mkdirSync(staging, { recursive: true });
		const install = await runner(
			npmCommand(),
			["install", packageName, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
			staging,
		);
		if (install.code !== 0) return `npm install failed: ${install.stderr.trim() || "unknown error"}`;

		const modules = join(staging, "node_modules");
		const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
		const packageDirectory =
			scope === undefined ? join(modules, packageName) : join(modules, scope, packageName.split("/")[1]!);
		if (!isDirectory(packageDirectory)) return `npm did not produce the package directory for ${packageName}`;

		copyPlugin(packageDirectory, target);
		// 其余顶层条目全是依赖：scoped 组整目录搬，包自身按真实路径排除
		for (const entry of readdirSync(modules)) {
			const from = join(modules, entry);
			if (!isDirectory(from)) continue;
			const to = join(target, "node_modules", entry);
			cpSync(from, to, {
				recursive: true,
				filter: (path) => !path.startsWith(packageDirectory + sep) && path !== packageDirectory,
			});
		}
		return undefined;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

async function installDependencies(target: string, runner: CommandRunner): Promise<string | undefined> {
	const manifest = join(target, "package.json");
	if (!existsSync(manifest)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: unknown };
		if (parsed.dependencies === undefined) return undefined;
	} catch {
		// 清单不是合法 JSON 时先让它过：后面的扫描会把这个坏行报出来
	}

	const install = await runner(
		npmCommand(),
		["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
		target,
	);
	if (install.code !== 0) return `npm install failed: ${install.stderr.trim() || "unknown error"}`;
	return undefined;
}

/** 复制插件内容；node_modules 与 .git 是来源自身的运行痕迹，不跟着走。 */
function copyPlugin(origin: string, target: string): void {
	mkdirSync(target, { recursive: true });
	cpSync(origin, target, {
		recursive: true,
		filter: (path) => {
			const name = basename(path);
			return name !== "node_modules" && name !== ".git";
		},
	});
}

function report(directory: string, options: { readonly restart: boolean }): readonly string[] {
	const lines: string[] = [...describeDeclarativeScan(scanDeclarativePlugins(directory))];
	// 顶层 .ts 文件是另一类插件（代码插件），扫描器不认它们，这里单独点名
	if (existsSync(directory)) {
		for (const entry of readdirSync(directory)) {
			if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
				lines.push(`code plugin ${entry.slice(0, -3)}: loads on next start`);
			}
		}
	}
	if (lines.length === 0) lines.push("no plugins installed");
	if (options.restart) lines.push("Restart reins to apply changes.");
	return lines;
}

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function execRunner(
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<{ readonly code: number; readonly stderr: string }> {
	return new Promise((settle) => {
		const child = spawn(command, args, {
			cwd,
			// Windows 上 npm 是 .cmd 批处理：不经 shell 起不来
			shell: process.platform === "win32",
			windowsHide: true,
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => settle({ code: -1, stderr: String(error) }));
		child.on("close", (code) => settle({ code: code ?? -1, stderr }));
	});
}
