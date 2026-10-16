import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TurnDriver } from "../agent/driver.ts";
import { ConfigError } from "../config/config-error.ts";
import { loadConfig, type Config } from "../config/config-file.ts";
import { loadModels, type ModelsConfig } from "../config/models-file.ts";
import { configFilePath, modelsFilePath, sessionsDir, spillDir } from "../config/paths.ts";
import { resolveSelection } from "../config/selection.ts";
import { createBuiltinLlmRegistry } from "../llm/registry.ts";
import { DEFAULT_RETRY_BASE_DELAY_MS } from "../llm/retry.ts";
import { PluginHost } from "../plugins/host.ts";
import { bundledPlugins } from "../plugins/registry.ts";
import { JsonlSession } from "../plugins/session-plugin/jsonl-store.ts";
import { UnrestrictedSandbox } from "../sandbox/policy.ts";
import { createCoreTools } from "../tools/builtin/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ResultSpiller } from "../tools/spill.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { formatConfigReport } from "./config-report.ts";
import { runPrintMode } from "./print-mode.ts";

/**
 * 运行时装配。
 *
 * 顺序是有讲究的：先把配置读出来（它决定用哪个模型、要不要隔离），再建工作区与工具，然后
 * 装载插件，最后才把驱动装起来。插件在信任与工作区之后加载，因此它在结构上无法影响这两件事。
 */
export async function main(argv: readonly string[]): Promise<number> {
	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			writeStderr(`reins: ${error.message}\n提示：reins --help 查看用法\n`);
			return 2;
		}
		throw error;
	}

	switch (options.command) {
		case "help":
			writeStdout(HELP_TEXT);
			return 0;
		case "version":
			writeStdout(`${readVersion()}\n`);
			return 0;
		case "config-check":
			return runConfigCheck(options);
		case "print":
			return runPrint(options);
	}
}

function runConfigCheck(options: CliOptions): number {
	const configFile = options.configPath ?? configFilePath();
	const modelsFile = options.modelsPath ?? modelsFilePath();

	try {
		const config = loadConfig(configFile);
		const models = loadModels(modelsFile);
		const selection = resolveSelection(config, models, configFile, modelsFile);
		writeStdout(
			formatConfigReport({
				configFile,
				modelsFile,
				reinsHome: process.env["REINS_HOME"],
				config,
				models,
				selection,
			}),
		);
		return 0;
	} catch (error) {
		if (error instanceof ConfigError) {
			writeStderr(`${error.display}\n`);
			return 1;
		}
		throw error;
	}
}

async function runPrint(options: CliOptions): Promise<number> {
	const configFile = options.configPath ?? configFilePath();
	const modelsFile = options.modelsPath ?? modelsFilePath();

	let config: Config;
	let models: ModelsConfig;
	try {
		config = loadConfig(configFile);
		models = loadModels(modelsFile);
	} catch (error) {
		if (error instanceof ConfigError) {
			writeStderr(`${error.display}\n`);
			return 1;
		}
		throw error;
	}

	let selection: ReturnType<typeof resolveSelection>;
	try {
		selection = resolveSelection(config, models, configFile, modelsFile);
	} catch (error) {
		if (error instanceof ConfigError) {
			writeStderr(`${error.display}\n`);
			return 1;
		}
		throw error;
	}

	const workRoot = resolveWorkRoot();
	const registry = new ToolRegistry(new ResultSpiller(config.spillThreshold, spillDir()));
	for (const tool of createCoreTools()) registry.register(tool, "core");

	const disabled = new Set(config.plugins.disabled);
	const host = new PluginHost(registry);
	const failures = await host.load(bundledPlugins().filter((plugin) => !disabled.has(plugin.name)));
	for (const failure of failures) {
		// 插件加载失败只说一声：一个写坏的插件不该让整个程序起不来
		writeStderr(`插件 ${failure.plugin} 装载失败：${failure.message}\n`);
	}

	const session = new JsonlSession({
		file: sessionFilePath(workRoot),
		id: randomBytes(8).toString("hex"),
		cwd: workRoot,
	});

	try {
		return await runPrintMode({
			prompt: options.prompt,
			createDriver: (onEvent) =>
				new TurnDriver({
					provider: selection.provider,
					model: selection.model,
					config,
					client: createBuiltinLlmRegistry().create(selection.provider, selection.model, {
						maxRetries: config.maxRetries,
						baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
					}),
					tools: registry,
					session,
					workspace: new WorkspaceBoundary(workRoot),
					sandbox: new UnrestrictedSandbox(),
					onEvent,
				}),
			stdout: writeStdout,
			stderr: writeStderr,
		});
	} finally {
		await session.close();
	}
}

/**
 * 会话文件路径。
 *
 * 文件名里带创建时间，便于按时间找人；后缀是短随机串，避免同一秒内启动两次时撞名。
 */
function sessionFilePath(workRoot: string): string {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	return join(sessionsDir(workRoot), `${stamp}_${randomBytes(4).toString("hex")}.jsonl`);
}

function resolveWorkRoot(): string {
	return process.cwd();
}

/** 版本号取自 package.json；源码即运行产物，因此相对路径在任何安装形态下都成立。 */
function readVersion(): string {
	const url = new URL("../../package.json", import.meta.url);
	const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
	if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
		const version = (parsed as { version: unknown }).version;
		if (typeof version === "string") return version;
	}
	return "未知";
}

function writeStdout(text: string): void {
	process.stdout.write(text);
}

function writeStderr(text: string): void {
	process.stderr.write(text);
}
