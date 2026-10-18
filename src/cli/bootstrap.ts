import { readFileSync } from "node:fs";

import { TurnDriver } from "../agent/driver.ts";
import { Compactor, estimateTokens } from "../agent/compactor.ts";
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
import { updateUserConfigValue } from "../config/write-back.ts";
import { createBuiltinLlmRegistry, type LlmRegistry } from "../llm/registry.ts";
import { DEFAULT_RETRY_BASE_DELAY_MS } from "../llm/retry.ts";
import { PermissionGate, PermissionPolicy, type Confirmer } from "../permission/policy.ts";
import { ModelReviewer } from "../permission/reviewer.ts";
import { PluginHost, type PluginFailure } from "../plugins/host.ts";
import { ExternalPlugins } from "../plugins/external.ts";
import { bundledPlugins } from "../plugins/registry.ts";
import { Session } from "../session/session.ts";
import type { SessionStore } from "../session/store.ts";
import { sumUsage } from "../session/usage.ts";
import { createSandbox } from "../sandbox/setup.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { TrustDecision } from "../workspace/trust.ts";
import { createCoreTools } from "../tools/builtin/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ResultSpiller } from "../tools/spill.ts";
import type { InteractiveRuntime } from "../tui/frontend.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { findProjectResources, recordTrust, resolveTrust } from "../workspace/trust.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { formatConfigReport } from "./config-report.ts";
import { runPrintMode } from "./print-mode.ts";
import { openSession } from "./session-target.ts";
import { runSessions } from "./sessions.ts";
import { askYesNo } from "./prompt.ts";

/**
 * 运行时装配。
 *
 * 顺序有讲究。配置最先读出来，它决定用哪个模型、要不要隔离、默认怎么审批。接着建审批链路：
 * 插件可以往策略里加规则，所以策略必须先存在，插件在装载时才能往它里面放东西。工具注册表
 * 再建，它持有审批入口。插件最后装载——在信任与工作区之后，因此插件在结构上无法影响这两件
 * 事。沙箱要等插件装载完，因为平台手段由插件提供。
 *
 * 交互模式还多一步：界面由插件提供，因此它在插件装载之后才存在；界面起来之前没有人可以问，
 * 审批确认这时按拒绝处理。
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
		case "config-check":
			return runConfigCheck(options);
		case "sessions":
			return runSessionsCommand(options);
		case "print":
			return runPrint(options);
		case "chat":
			return runChat(options);
	}
}

/**
 * `reins sessions`。
 *
 * 只需要配置与插件清单：列出与查看会话不碰模型，因此不要求 model 能在 providers.json 里对上，
 * 配置本身有问题时才报错。工作区自带的配置照旧要信任才读，插件清单也从那里来。
 */
async function runSessionsCommand(options: CliOptions): Promise<number> {
	const workRoot = process.cwd();
	try {
		const { config } = await loadEffectiveConfig(options);
		// 列会话不碰工具，但插件装载只有这一条路：会话仓库本身就是插件提供的
		const policy = new PermissionPolicy(config.approval);
		const host = new PluginHost(
			new ToolRegistry(new ResultSpiller(config.spillThreshold, spillDir()), new PermissionGate({ policy })),
			policy,
		);
		await loadBundledPlugins(config, host, workRoot);

		return runSessions(options, {
			workRoot,
			store: host.sessionStore(),
			stdout: writeStdout,
		});
	} catch (error) {
		if (error instanceof ConfigError) {
			writeStderr(`${error.display}\n`);
			return 1;
		}
		writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

async function runConfigCheck(options: CliOptions): Promise<number> {
	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	try {
		const { config, providersConfig, sources } = await loadEffectiveConfig(options);
		const selection = resolveSelection(config, providersConfig, configFile, providersFile);
		writeStdout(
			formatConfigReport({
				configFile: sources.join(" + "),
				providersFile,
				reinsHome: process.env["REINS_HOME"],
				config,
				providersConfig,
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

	const session = openSessionFor(options, workRoot, host.sessionStore());
	if (session === undefined) return 1;
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
 * 交互模式。
 *
 * 与非交互模式共用同一套装配，区别只有三处：审批确认接到界面上；界面由插件提供，没有界面就
 * 明确报错而不是退回到别的方式；退出时把会话文件位置说出来，使用者才知道东西存在哪。
 */
async function runChat(options: CliOptions): Promise<number> {
	if (options.assumeYes) {
		// 界面上随时可以选「允许」，这个开关在这里没有意义。静默忽略会让人以为它生效了
		writeStderr(
			"--yes has no meaning in the interactive UI: the UI asks anyway. To skip the asking, set approval to yolo in config.toml.\n",
		);
		return 2;
	}
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		writeStderr("The interactive UI needs a terminal. To run a single prompt, use reins -p <prompt>; see reins --help for usage.\n");
		return 2;
	}

	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	let effective: Awaited<ReturnType<typeof loadEffectiveConfig>>;
	let selection: ModelSelection;
	try {
		effective = await loadEffectiveConfig(options, askTrust);
		selection = resolveSelection(effective.config, effective.providersConfig, configFile, providersFile);
	} catch (error) {
		if (error instanceof ConfigError) {
			writeStderr(`${error.display}\n`);
			return 1;
		}
		throw error;
	}
	const { config } = effective;

	const workRoot = process.cwd();
	const workspace = new WorkspaceBoundary(workRoot);

	// 审批确认先留一个空位：界面接管终端之后由界面填上；在那之前没有人可以问，按拒绝处理
	let confirmer: Confirmer | undefined;
	const policy = new PermissionPolicy(config.approval);
	const gate = new PermissionGate({
		policy,
		reviewer: config.approval === "auto" ? createReviewer(config, selection, workRoot) : undefined,
		confirmer: async (question, detail) => (confirmer === undefined ? false : confirmer(question, detail)),
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
	for (const failure of failures) writeStderr(`Plugin ${failure.plugin} failed to load: ${failure.message}\n`);
	reportExternalFailures(await external.load());

	const frontend = host.frontend();
	if (frontend === undefined) {
		writeStderr(
			"No interactive UI available: the UI plugin is disabled or failed to load. To run a single prompt, use reins -p <prompt>.\n",
		);
		return 1;
	}

	let sandbox: SandboxView;
	try {
		sandbox = createSandboxFor(config, workRoot, host);
	} catch (error) {
		writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	warnUnsandboxedMcpServers(config);

	const session = openSessionFor(options, workRoot, host.sessionStore());
	if (session === undefined) return 1;
	const compactor = createCompactor(config, selection);

	const runtime: InteractiveRuntime = {
		cwd: workRoot,
		session: { id: session.id, path: session.path, entries: session.entryCount },
		provider: selection.provider.id,
		model: selection.model.id,
		approval: config.approval,
		sandbox: config.sandbox,
		notify: config.ui.notify,
		trust: {
			trusted: effective.trust.trusted,
			root: workRoot,
			files: effective.resources,
		},
		commands: host.commands(),
		runCommand: async (name, args) => {
			const lines: string[] = [];
			await host.runCommand(name, args, { cwd: workRoot, print: (line) => lines.push(line) });
			return lines;
		},
		createDriver: (onEvent) =>
			createDriverFor({ config, selection, compactor }, { registry, session, workspace, sandbox }, onEvent),
		sessionUsage: () => sumUsage(session.entries()),
		// 每帧都要问一次，所以只做一次线性估算；上下文大小决定了这点开销的上限，且只在回合运行时有调用方
		contextTokens: () => estimateTokens(session.state().messages),
		setConfirmer: (value) => {
			confirmer = value;
		},
		// 通知方式与信任清单写回用户级配置；界面只负责显示与触发，写文件这件事由宿主做
		setNotify: (mode) => updateUserConfigValue(["ui", "notify"], () => mode, configFile),
		setTrusted: (trusted) => recordTrust(workRoot, trusted),
	};

	try {
		await frontend.run(runtime);
		return 0;
	} catch (error) {
		writeStderr(`UI error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		await session.close();
	}
}

/**
 * 进入交互界面之前的信任询问。
 *
 * 问在界面起来之前：答案决定哪些配置生效，而配置决定界面按什么规矩跑。项目配置里的
 * 危险项已经被合并规则挡住（只能更严，不能放宽），所以先读不构成安全缺口。
 */
async function askTrust(): Promise<boolean> {
	const workRoot = process.cwd();
	const resources = findProjectResources(workRoot);
	const files = resources.files.join(", ");
	return askYesNo(`The workspace ships config that affects this run: ${files}. Read it?`);
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
	ask?: () => Promise<boolean>,
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

	const decision = await resolveTrust({
		root: workRoot,
		override: options.trust,
		trustedRoots: userConfig.config.plugins.trusted,
		// 非交互模式没有人可以问，因此不给询问入口，结论按不信任处理
		ask,
		hasProtectedResources: resources.length > 0,
	});

	if (decision.source === "flag" || decision.source === "asked") {
		// 命令行给出的结论与询问得到的结论都会被记下来，下次不必再给
		recordTrust(workRoot, decision.trusted);
		writeStderr(`Recorded ${workRoot} as ${decision.trusted ? "trusted" : "untrusted"}\n`);
	}

	if (!decision.trusted) {
		if (resources.length > 0) {
			const how = ask === undefined ? "Pass --trust to use them." : "Use /trust in the UI to enable them.";
			writeStderr(`Skipped the workspace config that needs trust: ${resources.join(", ")}\n${how}\n`);
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
async function loadBundledPlugins(config: Config, host: PluginHost, cwd: string): Promise<void> {
	const failures = await host.load(
		bundledPlugins({ cwd, version: readVersion(), mcpServers: [] }).filter(
			(plugin) => !disabledPlugins(config).has(plugin.name),
		),
	);
	for (const failure of failures) writeStderr(`Plugin ${failure.plugin} failed to load: ${failure.message}\n`);
}

/**
 * 按选项准备本次会话；选项指向的会话用不了时说明原因并返回 undefined。
 *
 * 会话存储由插件提供，它缺席时新建会话仍可用（只留在内存里），但必须说出来：使用者以为历史
 * 留在磁盘上、事后去找却发现什么都没有，是最难查的一种失败。
 */
function openSessionFor(
	options: CliOptions,
	workRoot: string,
	store: SessionStore | undefined,
): Session | undefined {
	const wantsExisting = options.continueSession || options.resume !== undefined;
	if (store === undefined && !wantsExisting) {
		writeStderr("No session store (session-plugin is disabled or failed to load), this session will not be saved to a file\n");
	}

	try {
		return openSession(options, { workRoot, store });
	} catch (error) {
		writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
		return undefined;
	}
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
