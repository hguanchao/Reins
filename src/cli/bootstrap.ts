import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TurnDriver } from "../agent/driver.ts";
import { ConfigError } from "../config/config-error.ts";
import { ConfigFile, type Config } from "../config/config-file.ts";
import { mergeConfigs, mergeModels } from "../config/merge.ts";
import { loadModels, type ModelsConfig } from "../config/models-file.ts";
import {
	configFilePath,
	modelsFilePath,
	projectConfigFilePath,
	projectModelsFilePath,
	sessionsDir,
	spillDir,
} from "../config/paths.ts";
import { resolveSelection, type ModelSelection } from "../config/selection.ts";
import { createBuiltinLlmRegistry, type LlmRegistry } from "../llm/registry.ts";
import { DEFAULT_RETRY_BASE_DELAY_MS } from "../llm/retry.ts";
import { PermissionGate, PermissionPolicy } from "../permission/policy.ts";
import { ModelReviewer } from "../permission/reviewer.ts";
import { PluginHost } from "../plugins/host.ts";
import { bundledPlugins } from "../plugins/registry.ts";
import { JsonlSession } from "../plugins/session-plugin/jsonl-store.ts";
import { createSandbox } from "../sandbox/setup.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import { createCoreTools } from "../tools/builtin/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ResultSpiller } from "../tools/spill.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { findProjectResources, recordTrust, resolveTrust } from "../workspace/trust.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { formatConfigReport } from "./config-report.ts";
import { runPrintMode } from "./print-mode.ts";

/**
 * 运行时装配。
 *
 * 顺序有讲究。配置最先读出来，它决定用哪个模型、要不要隔离、默认怎么审批。接着建审批链路：
 * 插件可以往策略里加规则，所以策略必须先存在，插件在装载时才能往它里面放东西。工具注册表
 * 再建，它持有审批入口。插件最后装载——在信任与工作区之后，因此插件在结构上无法影响这两件
 * 事。沙箱要等插件装载完，因为平台手段由插件提供。
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
		const { config, models, sources } = loadEffectiveConfig(options);
		const selection = resolveSelection(config, models, configFile, modelsFile);
		writeStdout(
			formatConfigReport({
				configFile: sources.join(" + "),
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
	let selection: ModelSelection;
	try {
		const effective = loadEffectiveConfig(options);
		config = effective.config;
		models = effective.models;
		selection = resolveSelection(config, models, configFile, modelsFile);
	} catch (error) {
		if (error instanceof ConfigError) {
			writeStderr(`${error.display}\n`);
			return 1;
		}
		throw error;
	}

	const workRoot = process.cwd();
	const workspace = new WorkspaceBoundary(workRoot);

	// 审批链路：策略先立起来，插件装载时往里加规则
	const policy = new PermissionPolicy(config.approval);
	const gate = new PermissionGate({
		policy,
		reviewer:
			config.approval === "auto" ? createReviewer(config, selection, workRoot) : undefined,
		// --yes 只把「没人可问」变成「算同意」；它不越过拒绝规则，也不越过审查模型
		confirmer: options.assumeYes ? async () => true : undefined,
	});

	const registry = new ToolRegistry(
		new ResultSpiller(config.spillThreshold, spillDir()),
		gate,
	);
	for (const tool of createCoreTools()) registry.register(tool, "core");

	const disabled = new Set(config.plugins.disabled);
	const host = new PluginHost(registry, policy);
	const failures = await host.load(bundledPlugins().filter((plugin) => !disabled.has(plugin.name)));
	for (const failure of failures) {
		// 插件加载失败只说一声：一个写坏的插件不该让整个程序起不来
		writeStderr(`插件 ${failure.plugin} 装载失败：${failure.message}\n`);
	}

	let sandbox: SandboxView;
	try {
		const setup = createSandbox(config.sandbox, workRoot, host.backends());
		sandbox = setup.sandbox;
		for (const warning of setup.warnings) writeStderr(`${warning}\n`);
	} catch (error) {
		writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
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
					workspace,
					sandbox,
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
 * 读出生效的配置。
 *
 * 用户级配置总是读；工作区自带的配置要先取得信任。缺少信任时不读，并且明确说出来——安静地
 * 跳过会让人以为项目设置生效了，而实际没有。
 *
 * 命令行显式指定了配置文件时跳过工作区配置：使用者已经指明了要看哪一份，再去叠加一份
 * 目录里的配置只会让「到底生效了什么」变得说不清。
 */
function loadEffectiveConfig(options: CliOptions): {
	readonly config: Config;
	readonly models: ModelsConfig;
	/** 实际参与合并的配置文件，按优先级从低到高 */
	readonly sources: readonly string[];
} {
	const workRoot = process.cwd();
	const userConfigPath = options.configPath ?? configFilePath();
	const userModelsPath = options.modelsPath ?? modelsFilePath();
	const userConfig = ConfigFile.load(userConfigPath);
	const userModels = loadModels(userModelsPath);

	if (options.configPath !== undefined) {
		return { config: userConfig.config, models: userModels, sources: [userConfigPath] };
	}

	const resources = findProjectResources(workRoot);
	const decision = resolveTrust({
		root: workRoot,
		override: options.trust,
		trustedRoots: userConfig.config.plugins.trusted,
		// 非交互模式没有人可以问，因此不给询问入口，结论按不信任处理
		ask: undefined,
		hasProtectedResources: resources.files.length > 0,
	});

	if (decision.source === "flag" && options.trust !== undefined) {
		// 命令行给出的结论会被记下来，下次不必再给
		recordTrust(workRoot, options.trust);
		writeStderr(`已把 ${workRoot} 记为${options.trust ? "信任" : "不信任"}。
`);
	}

	if (!decision.trusted) {
		if (resources.files.length > 0) {
			const skipped = resources.files.join("、");
			writeStderr(`工作区里有需要信任才能读取的配置，已跳过：${skipped}\n要使用它们请加 --trust。\n`);
		}
		return { config: userConfig.config, models: userModels, sources: [userConfigPath] };
	}

	const projectConfigPath = projectConfigFilePath(workRoot);
	const projectModelsPath = projectModelsFilePath(workRoot);
	const config = resources.files.includes(projectConfigPath)
		? mergeConfigs(userConfig, ConfigFile.load(projectConfigPath))
		: userConfig.config;
	const models = resources.files.includes(projectModelsPath)
		? mergeModels(userModels, loadModels(projectModelsPath))
		: userModels;
	const sources = resources.files.includes(projectConfigPath)
		? [userConfigPath, projectConfigPath]
		: [userConfigPath];
	return { config, models, sources };
}

/** 审查模型省略时用主模型。它只是判断一次调用该不该放行，不需要额外配置。 */
function createReviewer(
	config: Config,
	selection: ModelSelection,
	workRoot: string,
): ModelReviewer {
	const reviewModel = selection.reviewModel ?? selection.model;
	const registry: LlmRegistry = createBuiltinLlmRegistry();
	return new ModelReviewer({
		client: registry.create(selection.provider, reviewModel, {
			maxRetries: config.maxRetries,
			baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
		}),
		model: reviewModel.id,
		maxTokens: reviewModel.maxTokens ?? config.maxTokens,
		workspaceRoot: workRoot,
	});
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
