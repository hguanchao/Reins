import { readFileSync } from "node:fs";

import { TurnDriver } from "../agent/driver.ts";
import { Compactor } from "../agent/compactor.ts";
import { DEFAULT_SUBAGENT_STEPS, createSubagentTool } from "../agent/subagent.ts";
import type { AgentEventListener } from "../agent/events.ts";
import { ConfigError } from "../config/config-error.ts";
import { ConfigFile, type Config } from "../config/config-file.ts";
import { mergeConfigs, mergeProviders } from "../config/merge.ts";
import { loadProviders, type ProvidersConfig } from "../config/providers-file.ts";
import {
	configFilePath,
	providersFilePath,
	pluginsDir,
	projectConfigFilePath,
	projectProvidersFilePath,
	spillDir,
} from "../config/paths.ts";
import { resolveSelection, type ModelSelection } from "../config/selection.ts";
import { createBuiltinLlmRegistry, type LlmRegistry } from "../llm/registry.ts";
import { DEFAULT_RETRY_BASE_DELAY_MS } from "../llm/retry.ts";
import { PermissionGate, PermissionPolicy } from "../permission/policy.ts";
import { ModelReviewer } from "../permission/reviewer.ts";
import { PluginHost, type PluginFailure } from "../plugins/host.ts";
import { ExternalPlugins } from "../plugins/external.ts";
import { bundledPlugins, createBundledSessionStore } from "../plugins/registry.ts";
import { Session } from "../session/session.ts";
import type { SessionStore } from "../session/store.ts";
import { createSandbox } from "../sandbox/setup.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { TrustDecision } from "../workspace/trust.ts";
import { createCoreTools } from "../tools/builtin/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ResultSpiller } from "../tools/spill.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { findProjectResources, recordTrust, resolveTrust } from "../workspace/trust.ts";
import { runTui } from "../tui/layout.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { runPrintMode } from "./print-mode.ts";
import { createSession, resumeCommand, resumeSession } from "./session-target.ts";

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
			writeStderr(`reins: ${error.message}\nHint: run reins --help for usage\n`);
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
		case "print":
			return runPrint(options);
		case "tui":
			return runTuiMode(options);
	}
}

/**
 * 启动全屏界面。
 *
 * 备用屏只有在真实终端上才有意义；输入输出被重定向时直接报错，避免程序在管道里挂起等待
 * 一个永远不会到来的按键。
 *
 * 进入界面之前就把会话落成文件：界面退出后要在主屏给出接续命令，没有文件的会话接到命令
 * 也找不回来。
 */
async function runTuiMode(options: CliOptions): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		writeStderr("reins: the full-screen interface needs an interactive terminal; pass a prompt to run non-interactively\n");
		return 1;
	}

	const workRoot = process.cwd();
	const store = createBundledSessionStore();
	let session: Session | undefined;
	try {
		session =
			options.resume === undefined
				? createSession(workRoot, store)
				: resumeSession(workRoot, options.resume, store);
		if (options.resume === undefined) session.begin();
	} catch (error) {
		await session?.close();
		writeStderr(`reins: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (session === undefined) return 1;

	try {
		const code = await runTui({ version: readVersion() });
		writeStdout(`${resumeCommand(session.id)}\n`);
		return code;
	} catch (error) {
		writeStderr(`reins: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		await session.close();
	}
}

async function runPrint(options: CliOptions): Promise<number> {
	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	let config: Config;
	let providersConfig: ProvidersConfig;
	let selection: ModelSelection;
	try {
		const effective = await loadEffectiveConfig(options);
		config = effective.config;
		providersConfig = effective.providersConfig;
		selection = resolveSelection(config, providersConfig, configFile, providersFile);
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

	const host = new PluginHost(registry, policy);
	const external = prepareExternalPlugins(host);
	const failures = await host.load(
		bundledPlugins({ cwd: workRoot, version: readVersion(), mcpServers: config.mcpServers }).filter(
			(plugin) => !disabledPlugins(config).has(plugin.name),
		),
	);
	for (const failure of failures) {
		// 插件加载失败只说一声：一个写坏的插件不该让整个程序起不来
		writeStderr(`Plugin ${failure.plugin} failed to load: ${failure.message}\n`);
	}
	reportExternalFailures(await external.load());

	let sandbox: SandboxView;
	try {
		sandbox = createSandboxFor(config, workRoot, host);
	} catch (error) {
		writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	warnUnsandboxedMcpServers(config);

	const session = createSessionFor(workRoot, host.sessionStore());
	const compactor = createCompactor(config, selection);

	try {
		return await runPrintMode({
			prompt: options.prompt,
			createDriver: (onEvent) =>
				createDriverFor({ config, selection, compactor }, { registry, session, workspace, sandbox }, onEvent),
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
async function loadEffectiveConfig(
	options: CliOptions,
): Promise<{
	readonly config: Config;
	readonly providersConfig: ProvidersConfig;
	/** 实际参与合并的配置文件，按优先级从低到高 */
	readonly sources: readonly string[];
	readonly trust: TrustDecision;
	/** 工作区里需要信任才会读取的文件 */
	readonly resources: readonly string[];
}> {
	const workRoot = process.cwd();
	const userConfigPath = options.configPath ?? configFilePath();
	const userProvidersPath = options.providersPath ?? providersFilePath();
	const userConfig = ConfigFile.load(userConfigPath);
	const userProviders = loadProviders(userProvidersPath);
	const resources = findProjectResources(workRoot).files;

	if (options.configPath !== undefined) {
		return {
			config: userConfig.config,
			providersConfig: userProviders,
			sources: [userConfigPath],
			trust: { trusted: false, source: "none" },
			resources,
		};
	}

	const decision = resolveTrust({
		root: workRoot,
		override: options.trust,
		trustedRoots: userConfig.config.plugins.trusted,
		hasProtectedResources: resources.length > 0,
	});

	if (decision.source === "flag") {
		// 命令行给出的结论会被记下来，下次不必再给
		recordTrust(workRoot, decision.trusted);
		writeStderr(`Recorded ${workRoot} as ${decision.trusted ? "trusted" : "untrusted"}\n`);
	}

	if (!decision.trusted) {
		if (resources.length > 0) {
			writeStderr(
				`Skipped the workspace config that needs trust: ${resources.join(", ")}\nPass --trust to use them.\n`,
			);
		}
		return {
			config: userConfig.config,
			providersConfig: userProviders,
			sources: [userConfigPath],
			trust: decision,
			resources,
		};
	}

	const projectConfigPath = projectConfigFilePath(workRoot);
	const projectProvidersPath = projectProvidersFilePath(workRoot);
	const config = resources.includes(projectConfigPath)
		? mergeConfigs(userConfig, ConfigFile.load(projectConfigPath))
		: userConfig.config;
	const providersConfig = resources.includes(projectProvidersPath)
		? mergeProviders(userProviders, loadProviders(projectProvidersPath))
		: userProviders;
	const sources = resources.includes(projectConfigPath)
		? [userConfigPath, projectConfigPath]
		: [userConfigPath];
	return { config, providersConfig, sources, trust: decision, resources };
}

/**
 * 说清楚沙箱管不到哪些东西。
 *
 * 沙箱管的是本程序发出的命令，管不到 MCP server 进程：它是使用者自己配置的本地程序，与插件
 * 同级。这件事不吭声就会被当成「开了沙箱就什么都隔离了」——而按沙箱的语义，`read-only` 是
 * 「不允许写」这样一个承诺。
 */
function warnUnsandboxedMcpServers(config: Config): void {
	if (config.sandbox === "off") return;
	const stdio = config.mcpServers.filter((server) => !server.disabled && server.type === "stdio");
	if (stdio.length === 0) return;
	writeStderr(
		`Note: sandbox mode is ${config.sandbox}, but these MCP servers are local processes started by reins and are not constrained by the sandbox: ` +
			`${stdio.map((server) => server.name).join(", ")}\n`,
	);
}

function disabledPlugins(config: Config): ReadonlySet<string> {
	return new Set(config.plugins.disabled);
}

function createSandboxFor(config: Config, workRoot: string, host: PluginHost): SandboxView {
	const setup = createSandbox(config.sandbox, workRoot, host.backends());
	for (const warning of setup.warnings) writeStderr(`${warning}\n`);
	return setup.sandbox;
}

function createClient(config: Config, selection: ModelSelection): ReturnType<LlmRegistry["create"]> {
	return createBuiltinLlmRegistry().create(selection.provider, selection.model, {
		maxRetries: config.maxRetries,
		baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
	});
}

/**
 * 建立压缩器。
 *
 * 上下文上限必须由使用者声明：providers.json 的 contextWindow 或 config.toml 的 context_window，
 * 两处都没有就不压缩，并且明确说出来——没有上限就没有「快满了」这回事，使用者会以为程序在管
 * 上下文，其实没有。
 */
function createCompactor(
	config: Config,
	selection: ModelSelection,
): Compactor | undefined {
	const contextWindow = selection.model.contextWindow ?? config.contextWindow;
	if (contextWindow === undefined) {
		writeStderr(
			"No context window declared (providers.json sets no contextWindow, config.toml sets no context_window). " +
				"Context will not be compacted automatically this run.\n",
		);
		return undefined;
	}

	// 摘要用 compact_model；它省略时用主模型。两者都在同一个 provider 内，配置层已校验
	const model = selection.compactModel ?? selection.model;
	return new Compactor({
		client: createBuiltinLlmRegistry().create(selection.provider, model, {
			maxRetries: config.maxRetries,
			baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
		}),
		provider: selection.provider.id,
		model,
		contextWindow,
		maxTokens: config.maxTokens,
	});
}

/** 一次运行的驱动。交互模式每次提交都要新建一个：它的生命周期就是一轮对话。 */
function createDriverFor(
	context: {
		readonly config: Config;
		readonly selection: ModelSelection;
		readonly compactor: Compactor | undefined;
	},
	shared: {
		readonly registry: ToolRegistry;
		readonly session: Session;
		readonly workspace: WorkspaceBoundary;
		readonly sandbox: SandboxView;
	},
	onEvent: AgentEventListener,
): TurnDriver {
	// 主对话与子代理共用同一个客户端：它们只是同一个端点的两次请求，客户端本身没有连接状态
	const client = createClient(context.config, context.selection);
	const tools = shared.registry.withExtraTool(
		createSubagentTool({
			provider: context.selection.provider,
			model: context.selection.model,
			config: context.config,
			client,
			// 交给子代理的是不含子代理工具的那一份，因此子代理不会再派子代理
			tools: shared.registry,
			session: shared.session,
			maxSteps: context.config.maxTurns ?? DEFAULT_SUBAGENT_STEPS,
		}),
	);

	return new TurnDriver({
		provider: context.selection.provider,
		model: context.selection.model,
		config: context.config,
		client,
		tools,
		session: shared.session,
		workspace: shared.workspace,
		sandbox: shared.sandbox,
		onEvent,
		...(context.compactor === undefined ? {} : { compactor: context.compactor }),
	});
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
 * 建好外部插件的装载器，并登记 /reload。
 *
 * 命令要赶在插件装载之前登记：先占住名字，插件再想用同一个名字就会成为一条清楚的装载失败，
 * 而不是启动到一半崩掉。
 */
function prepareExternalPlugins(host: PluginHost): ExternalPlugins {
	const external = new ExternalPlugins({ directory: pluginsDir(), host });
	host.addCommand({
		name: "reload",
		description: "Reload external plugins (no restart needed after edits)",
		async run(_args, context) {
			const failures = await external.load();
			if (failures.length === 0) {
				context.print("External plugins reloaded");
				return;
			}
			context.print("External plugins reloaded, but these plugins failed to load:");
			for (const failure of failures) context.print(`  ${failure.plugin}: ${failure.message}`);
		},
	});
	return external;
}

function reportExternalFailures(failures: readonly PluginFailure[]): void {
	for (const failure of failures) {
		writeStderr(`External plugin ${failure.plugin} failed to load: ${failure.message}\n`);
	}
}

/**
 * 装载随包分发的插件。
 *
 * 失败只说一声：一个写坏的插件不该让整个程序起不来。禁用清单来自配置，而配置在装载之前
 * 就已经读过并取得过信任了。
 *
 * 这里不给 MCP server，也不装外部插件：`reins sessions` 只列会话，为了显示一份清单去起一堆
 * 外部进程、跑一遍别人的代码，既慢又会在使用者看不见的地方留下副作用。
 */
/**
 * 新建本次会话。
 *
 * 会话存储由插件提供，它缺席时新建会话仍可用（只留在内存里），但必须说出来：使用者以为历史
 * 留在磁盘上、事后去找却发现什么都没有，是最难查的一种失败。
 */
function createSessionFor(workRoot: string, store: SessionStore | undefined): Session {
	if (store === undefined) {
		writeStderr("No session store (session-plugin is disabled or failed to load), this session will not be saved to a file\n");
	}
	return createSession(workRoot, store);
}

/** 版本号取自 package.json；源码即运行产物，因此相对路径在任何安装形态下都成立。 */
function readVersion(): string {
	const url = new URL("../../package.json", import.meta.url);
	const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
	if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
		const version = (parsed as { version: unknown }).version;
		if (typeof version === "string") return version;
	}
	return "unknown";
}

function writeStdout(text: string): void {
	process.stdout.write(text);
}

function writeStderr(text: string): void {
	process.stderr.write(text);
}
