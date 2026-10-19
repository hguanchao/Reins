import { basename } from "node:path";

import { TurnDriver } from "../agent/driver.ts";
import { Compactor, estimateTokens } from "../agent/compactor.ts";
import { DEFAULT_SUBAGENT_STEPS, createSubagentTool } from "../agent/subagent.ts";
import type { AgentEventListener } from "../agent/events.ts";
import { ConfigError } from "../config/config-error.ts";
import { ConfigFile, type Config } from "../config/config-file.ts";
import { initializeConfigFiles } from "../config/initialize.ts";
import { ModelCatalog } from "../config/model-catalog.ts";
import { updateModelSelection, updateUserConfigValue } from "../config/write-back.ts";
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
import { clampEffort } from "../llm/effort.ts";
import { DEFAULT_RETRY_BASE_DELAY_MS } from "../llm/retry.ts";
import { PermissionGate, PermissionPolicy, type ApprovalReviewer } from "../permission/policy.ts";
import { ApprovalBroker } from "../permission/approval.ts";
import { ModelReviewer } from "../permission/reviewer.ts";
import { PluginHost, type PluginFailure } from "../plugins/host.ts";
import { ExternalPlugins } from "../plugins/external.ts";
import { bundledPlugins } from "../plugins/registry.ts";
import { Session } from "../session/session.ts";
import type { SessionStore } from "../session/store.ts";
import { cacheHitRate as usageCacheHitRate, sumUsage } from "../session/usage.ts";
import { createSandbox } from "../sandbox/setup.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { TrustDecision } from "../workspace/trust.ts";
import { createCoreTools } from "../tools/builtin/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ResultSpiller } from "../tools/spill.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { currentBranch } from "../workspace/git.ts";
import { findProjectResources, recordTrust, resolveTrust } from "../workspace/trust.ts";
import { runTui, type EffortMenuSource, type ModelMenuSource } from "../tui/layout.ts";
import { buildTranscriptHistory } from "../tui/history.ts";
import type { FooterInfo } from "../tui/footer.ts";
import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { runPrintMode } from "./print-mode.ts";
import { createSession, resumeCommand, resumeSession } from "./session-target.ts";
import { readVersion } from "../version.ts";

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
			initializeConfig(options);
			return runPrint(options);
		case "tui":
			return runTuiMode(options);
	}
}

/**
 * 补齐缺失的配置模板。
 *
 * 显式指定了 --config / --providers 时不碰默认位置：使用者已经指明要看哪一份，再创建一份
 * 不会被读取的文件只会让人困惑。模板是启动的默认准备动作，补上了也不出声——报一声反而像
 * 出了问题；创建失败才报告，且不阻止启动，接下来读配置时会给出具体错误。
 */
function initializeConfig(options: CliOptions): void {
	try {
		initializeConfigFiles({
			config: options.configPath === undefined,
			providers: options.providersPath === undefined,
		});
	} catch (error) {
		writeStderr(
			`reins: could not create configuration templates: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

/**
 * 启动全屏界面。
 *
 * 备用屏只有在真实终端上才有意义；输入输出被重定向时直接报错，避免程序在管道里挂起等待
 * 一个永远不会到来的按键。确认界面起得来之后先静默补齐缺失的配置模板，再读配置。
 *
 * 配置读不出来也照常进入界面：主区域用一行提示说明原因，输入不产生对话。只有
 * provider/model 对不上时仍建立模型目录，/model 选中后写回配置并恢复；完整的文件与行列
 * 信息由非交互模式输出，界面里只保留最短的必要信息。
 *
 * 会话文件在配置正常时启动即建立；受限模式下等到选型成功后再建立，避免留下一个空会话。
 */
async function runTuiMode(options: CliOptions): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		writeStderr("reins: the full-screen interface needs an interactive terminal; pass a prompt to run non-interactively\n");
		return 1;
	}

	// 确认界面起得来才补配置模板：起不来时不在磁盘上留下半套准备
	initializeConfig(options);

	const workRoot = process.cwd();
	const loaded = await loadSelection(options);
	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	// 配置完全读不出来：只显示警告，不装配 agent，/model 与 /effort 都不可用
	if (!loaded.ok && !loaded.recoverable) {
		const session = createSession(workRoot, undefined);
		try {
			return await runTui({
				version: readVersion(),
				info: createUnavailableFooterInfo(workRoot, session),
				warning: `Config error: ${loaded.error.message}`,
				ready: false,
			});
		} catch (error) {
			writeStderr(`reins: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		} finally {
			await session.close();
		}
	}

	const config = loaded.ok ? loaded.value.config : loaded.config;
	const providersConfig = loaded.ok ? loaded.value.providersConfig : loaded.providersConfig;
	const initialSelection = loaded.ok ? loaded.value.selection : undefined;

	// 权限、工具、插件与沙箱：与非交互模式使用同一条装配路径
	const approvals = new ApprovalBroker();
	const policy = new PermissionPolicy(config.approval);
	const catalog = new ModelCatalog(providersConfig, config, initialSelection);
	let activeConfig = config;
	const reviewer =
		config.approval === "auto"
			? createDynamicReviewer(catalog, () => activeConfig, workRoot)
			: undefined;
	const gate = new PermissionGate({
		policy,
		reviewer,
		confirmer: approvals.request,
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

	const workspace = new WorkspaceBoundary(workRoot);
	const store = host.sessionStore();
	let session: Session | undefined;
	try {
		session =
			options.resume === undefined
				? createSessionFor(workRoot, store)
				: store === undefined
					? (() => {
							throw new Error("No session store; cannot resume this session");
						})()
					: resumeSession(workRoot, options.resume, store);
		if (options.resume === undefined && loaded.ok) session.begin();
	} catch (error) {
		await session?.close();
		writeStderr(`reins: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (session === undefined) return 1;

	let sessionPersisted =
		options.resume !== undefined || (loaded.ok && session.path !== null);
	/** 从受限模式恢复后补建会话文件；失败只报告，不阻止本次使用。 */
	const markSessionReady = (): void => {
		if (sessionPersisted || session.path === null) return;
		try {
			session.begin();
			sessionPersisted = true;
		} catch (error) {
			writeStderr(
				`reins: could not create session file: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	};

	let footerInfo =
		initialSelection !== undefined
			? createFooterInfo(workRoot, activeConfig, initialSelection, session)
			: createUnavailableFooterInfo(workRoot, session);
	const history = buildTranscriptHistory(session.state().messages);
	const refreshInfo = (): void => {
		const current = catalog.selection;
		if (current !== undefined) {
			footerInfo = createFooterInfo(workRoot, activeConfig, current, session);
		}
	};

	/** 一轮真实对话。模型/思考等级都从当前目录读取，切换后下一轮立即生效。 */
	const runTurn = async (
		prompt: string,
		onEvent: AgentEventListener,
		signal: AbortSignal,
	): Promise<void> => {
		const current = catalog.selection;
		if (current === undefined) throw new Error("No model selected; run /model first");
		const compactor = createCompactor(activeConfig, current);
		const driver = createDriverFor(
			{ config: activeConfig, selection: current, compactor },
			{ registry, session, workspace, sandbox },
			onEvent,
		);
		await driver.run(prompt, signal);
	};

	const modelMenu = createModelMenuSource({
		catalog,
		config: activeConfig,
		providersConfig,
		configFile,
		providersFile,
		writePath: configFile,
		onSelection: (next) => {
			footerInfo = createFooterInfo(workRoot, activeConfig, next, session);
		},
		onReady: markSessionReady,
	});
	const effortMenu = createEffortMenuSource({
		getConfig: () => activeConfig,
		writePath: configFile,
		onConfigChange: (next) => {
			activeConfig = next;
			refreshInfo();
		},
	});

	const warning = loaded.ok ? undefined : `Config error: ${loaded.error.message}`;
	const ready = loaded.ok;

	try {
		const code = await runTui({
			version: readVersion(),
			info: () => footerInfo,
			warning,
			ready,
			agent: { runTurn, refreshInfo },
			approval: approvals,
			modelMenu,
			effortMenu,
			history,
		});
		if (sessionPersisted) writeStdout(`${resumeCommand(session.id)}\n`);
		return code;
	} catch (error) {
		writeStderr(`reins: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		await session.close();
	}
}

/**
 * 审查模型跟随当前选型。
 *
 * 审批为 auto 时，插件的加严规则仍可能把某次调用交回审查模型；/model 切换后应当用新模型
 * 审查，而不是继续用启动时那一个。
 */
function createDynamicReviewer(
	catalog: ModelCatalog,
	getConfig: () => Config,
	workRoot: string,
): ApprovalReviewer {
	return {
		async review(tool, args, signal) {
			const selection = catalog.selection;
			if (selection === undefined) {
				return { allowed: false, reason: "No model is selected; denied" };
			}
			return createReviewer(getConfig(), selection, workRoot).review(tool, args, signal);
		},
	};
}

/**
 * 模型菜单的宿主实现。
 *
 * 切换本身只改会话内的目录；确认后把 provider/model 写进配置，再用写好的配置重新校验一次。
 * 写盘或校验失败时保持受限状态，并把原因一并交给界面显示。
 */
function createModelMenuSource(options: {
	readonly catalog: ModelCatalog;
	readonly config: Config;
	readonly providersConfig: ProvidersConfig;
	readonly configFile: string;
	readonly providersFile: string;
	readonly writePath: string;
	readonly onSelection: (selection: ModelSelection) => void;
	readonly onReady: () => void;
}): ModelMenuSource {
	return {
		list: () => options.catalog.options(),
		select: (item) => {
			const outcome = options.catalog.switchTo(item.provider, item.model);
			options.onSelection(outcome.selection);
			const warnings = [...outcome.warnings];

			try {
				updateModelSelection(item.provider, item.model, options.writePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					warnings: [...warnings, message],
					ready: false,
					warning: `Config error: ${message}`,
				};
			}

			try {
				// 写回后按完整配置再校验一次：compact_model / review_model 可能仍指向旧 provider
				resolveSelection(
					{ ...options.config, provider: item.provider, model: item.model },
					options.providersConfig,
					options.configFile,
					options.providersFile,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					warnings: [...warnings, message],
					ready: false,
					warning: `Config error: ${message}`,
				};
			}

			options.onReady();
			return { warnings, ready: true, warning: undefined };
		},
	};
}

/**
 * 思考等级菜单的宿主实现。
 *
 * 写入失败直接抛错，由界面显示原因；成功后再更新内存里的配置，页脚随之刷新。
 */
function createEffortMenuSource(options: {
	readonly getConfig: () => Config;
	readonly writePath: string;
	readonly onConfigChange: (config: Config) => void;
}): EffortMenuSource {
	return {
		current: () => options.getConfig().reasoningEffort,
		select: (level) => {
			updateUserConfigValue(["reasoning_effort"], () => level, options.writePath);
			options.onConfigChange({ ...options.getConfig(), reasoningEffort: level });
		},
	};
}

/**
 * 输入框下方的常驻信息。
 *
 * 全部取自本次运行的配置与会话：模型与思考强度是实际会发出去的那一组，上下文与缓存命中率
 * 来自会话记录，界面不自己猜。接续旧会话时，这两项从历史里算出来；新会话则是零。
 */
function createFooterInfo(
	workRoot: string,
	config: Config,
	selection: ModelSelection,
	session: Session,
): FooterInfo {
	return {
		project: basename(workRoot),
		branch: currentBranch(workRoot),
		model: selection.model.id,
		effort:
			clampEffort(
				config.reasoningEffort,
				selection.model.reasoning,
				selection.model.thinkingLevelMap,
			) ?? "off",
		contextUsed: estimateTokens(session.state().messages),
		contextWindow: selection.model.contextWindow ?? config.contextWindow,
		cacheHitRate: usageCacheHitRate(sumUsage(session.entries())),
	};
}

/**
 * 配置不可用时的常驻信息。
 *
 * 模型与思考强度留空而不是猜一个值：这时没有可用的选型，显示任何具体模型都会让人以为
 * 请求会发到那里。会话本身的计数仍然准确，照常显示。
 */
function createUnavailableFooterInfo(workRoot: string, session: Session): FooterInfo {
	return {
		project: basename(workRoot),
		branch: currentBranch(workRoot),
		model: "-",
		effort: "-",
		contextUsed: estimateTokens(session.state().messages),
		contextWindow: undefined,
		cacheHitRate: usageCacheHitRate(sumUsage(session.entries())),
	};
}

async function runPrint(options: CliOptions): Promise<number> {
	const loaded = await loadSelection(options);
	if (!loaded.ok) {
		writeStderr(`${loaded.error.display}\n`);
		return 1;
	}
	const { config, selection } = loaded.value;

	const workRoot = process.cwd();
	const workspace = new WorkspaceBoundary(workRoot);

	// 审批链路：策略先立起来，插件装载时往里加规则
	const policy = new PermissionPolicy(config.approval);
	// 一次性提问没有人可问，因此不接 confirmer：需要询问的调用按拒绝处理
	const gate = new PermissionGate({
		policy,
		reviewer:
			config.approval === "auto" ? createReviewer(config, selection, workRoot) : undefined,
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
 * 读出生效配置并解析出所使用的模型。
 *
 * 交互与非交互两种启动方式共用同一条校验。返回错误而不是直接退出，让两种模式各自决定
 * 怎么处理：全屏界面把错误留在主区域继续显示，非交互模式没有可展示错误的地方，直接退出。
 */
export type SelectionResult =
	| {
			readonly ok: true;
			readonly value: {
				readonly config: Config;
				readonly providersConfig: ProvidersConfig;
				readonly selection: ModelSelection;
			};
	  }
	| {
			/** 配置本身读得动，只是 provider/model 对不上；/model 可以修复 */
			readonly ok: false;
			readonly recoverable: true;
			readonly config: Config;
			readonly providersConfig: ProvidersConfig;
			readonly error: ConfigError;
	  }
	| { readonly ok: false; readonly recoverable: false; readonly error: ConfigError };

export async function loadSelection(options: CliOptions): Promise<SelectionResult> {
	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	let effective: Awaited<ReturnType<typeof loadEffectiveConfig>>;
	try {
		effective = await loadEffectiveConfig(options);
	} catch (error) {
		if (error instanceof ConfigError) return { ok: false, recoverable: false, error };
		throw error;
	}

	try {
		return {
			ok: true,
			value: {
				config: effective.config,
				providersConfig: effective.providersConfig,
				selection: resolveSelection(
					effective.config,
					effective.providersConfig,
					configFile,
					providersFile,
				),
			},
		};
	} catch (error) {
		if (error instanceof ConfigError) {
			return {
				ok: false,
				recoverable: true,
				config: effective.config,
				providersConfig: effective.providersConfig,
				error,
			};
		}
		throw error;
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

function writeStdout(text: string): void {
	process.stdout.write(text);
}

function writeStderr(text: string): void {
	process.stderr.write(text);
}
