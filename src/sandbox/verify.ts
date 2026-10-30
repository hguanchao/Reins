import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveShell, type Shell } from "#src/tools/shell.ts";
import { isPathInside } from "#src/workspace/boundary.ts";
import type { SandboxView } from "#src/sandbox/policy.ts";
import { quoteForShell } from "#src/sandbox/shell-quote.ts";

/** 一次探针的执行时限:挂住的沙箱说明配置有问题,等更久没有意义。 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 核对命令隔离是否真的生效。
 *
 * 隔离后端配错了是很糟的一种情形：看起来开着，实际没拦住，而使用者会因为「我开了沙箱」而更
 * 放心地让模型去做事。所以真正依赖它之前先试一次。
 *
 * 分两步，因为「命令失败」有两种完全不同的原因：
 *
 * 一、先跑一条必然允许的命令。它失败说明沙箱本身起不来（容器里没有 user namespace、
 *     seccomp 拦截、后端参数错位……），此时每条命令都会失败，必须当场说清楚，否则之后
 *     所有失败都会被当成「命令写错了」。
 *
 * 二、再往工作区之外写一个文件。写得进去说明没隔离住，宁可起不来，也不要带着看起来有效
 *     的保护继续跑。
 *
 * 探针只写一个自己的临时文件，无论结果如何都会删掉。
 */
export function verifyCommandIsolation(sandbox: SandboxView, root: string): void {
	// 第一步：沙箱至少要能跑通一条什么都不做的命令
	const smoke = sandbox.wrapCommand(":");
	if (!runsToCompletion(smoke)) {
		throw new Error(
			`The isolation backend cannot run commands at all: \`${smoke}\` failed. ` +
				"Every command would fail this way while looking like an ordinary command error. " +
				"Check the sandbox setting in config.toml and the isolation backend for this platform.",
		);
	}

	// 第二步：工作区之外必须写不进去。找不到合适的探针位置时说明为什么没法验证——
	// 静默通过等于声称隔离生效，而实际一次都没试过。
	const probePath = isolationProbePath(root);
	if (probePath === undefined) {
		throw new Error(
			"Cannot verify command isolation: no writable location outside the workspace and outside " +
				"the temp directories was found. Without a probe, isolation that looks on but does " +
				"nothing cannot be ruled out. Set sandbox to off in config.toml, or run from a workspace " +
				"outside the temp directories.",
		);
	}

	const wrapped = sandbox.wrapCommand(`echo probe > ${quoteForShell(probePath)}`);
	const commandSucceeded = runProbe(wrapped);

	const leaked = existsSync(probePath);
	try {
		rmSync(probePath, { force: true });
	} catch {
		// 清理失败不影响判定，探针文件本身无害
	}

	if (commandSucceeded || leaked) {
		throw new Error(
			`Command isolation is not working: writing ${probePath} should have been refused but was not. ` +
				"Continuing with isolation that looks on but does nothing is more dangerous, so stopping here. " +
				"Check the sandbox setting in config.toml and the isolation backend for this platform.",
		);
	}
}

/** 命令是否跑完并成功退出；超时、起不来、非零退出都算失败。 */
function runsToCompletion(command: string): boolean {
	return runProbe(command);
}

/**
 * 用项目自己的 shell 跑一段探针命令。
 *
 * 不能直接用 execSync 的默认 shell：Windows 上那是 cmd.exe，而包装后的命令是 POSIX 语法
 * （单引号引用、`>` 重定向在两种 shell 里含义也不同）。用错 shell 会让每条探针都失败，
 * 「失败」于是被误读成「隔离生效」。
 */
function runProbe(command: string): boolean {
	let shell: Shell;
	try {
		shell = resolveShell();
	} catch {
		// 连 shell 都没有：无法验证，按失败处理，由调用方报出来
		return false;
	}
	try {
		execFileSync(shell.command, shell.args(command), {
			stdio: "ignore",
			timeout: PROBE_TIMEOUT_MS,
			env: { ...process.env, ...shell.env },
			windowsHide: true,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * 选一个「工作区之外、沙箱没放开、而且当前用户真能写」的位置放探针。
 *
 * 三个条件都不能省：
 *
 * - 不能在工作区内，那里本来就允许写，写了也不算泄漏；
 * - 不能在临时目录里，沙箱会为编译测试放开 /tmp，探针落在那儿必然写得进去，于是
 *   「隔离生效」会被误判成「隔离失效」，工作区位于 /tmp 下的 CI 环境根本起不来；
 * - 必须是可写的，否则探针命令在沙箱内外都会失败，「失败」就证明不了任何事。
 *
 * 用户主目录优先：它几乎总是可写，也几乎不会落在临时目录里。
 */
function isolationProbePath(root: string): string | undefined {
	const writableTempDirs = new Set([tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]);
	const candidates = [homedir(), dirname(root), "/var/tmp", "/usr/local", "/opt", "/"];

	for (const directory of candidates) {
		if (directory === root) continue;
		// 工作区就是主目录（或包含它）时，往那里写属于「工作区内」，证明不了隔离
		if (isPathInside(root, directory)) continue;
		if (writableTempDirs.has(directory)) continue;
		if (!isWritableDirectory(directory)) continue;
		// 探针命令由 shell 执行：Windows 上的反斜杠路径在 Git Bash 里会被当成转义，
		// 写不进去，于是「命令失败」被误读成「隔离生效」。统一换成 POSIX 分隔符。
		return join(directory, `.reins-isolation-probe-${process.pid}`).replaceAll("\\", "/");
	}
	return undefined;
}

function isWritableDirectory(directory: string): boolean {
	try {
		accessSync(directory, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
