import { describeError } from "../describe-error.ts";
import { TurnDriver } from "../agent/driver.ts";
import type { AgentEventListener } from "../agent/events.ts";
import type { PromptSkill } from "../agent/prompt.ts";
import { Compactor, compactionWindow } from "../agent/compactor.ts";
import { DEFAULT_SUBAGENT_STEPS, createSubagentTool } from "../agent/subagent.ts";
import type { PromptInstruction } from "../agent/instructions.ts";
import type { Config } from "../config/file.ts";
import { pluginsDir, spillDir } from "../config/paths.ts";
import { createBuiltinLlmRegistry, type LlmRegistry } from "../llm/registry.ts";
import { DEFAULT_RETRY_BASE_DELAY_MS } from "../llm/retry.ts";
import { ModelReviewer } from "../permission/reviewer.ts";
import { PermissionGate, PermissionPolicy } from "../permission/policy.ts";
import { ExternalPlugins } from "../plugins/external.ts";
import { PluginHost, type PluginFailure } from "../plugins/host.ts";
import { bundledPlugins, type McpStatusSource } from "../plugins/registry.ts";
import { createSandbox, type SandboxInfo } from "../sandbox/setup.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { Session } from "../session/session.ts";
import type { ModelSelection } from "../config/selection.ts";
import { JobManager } from "../tools/jobs.ts";
import { createCoreTools } from "../tools/builtin/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ResultSpiller } from "../tools/spill.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import type { ModelEntry, ProviderEntry } from "../config/providers-file.ts";
import { readVersion } from "../version.ts";
import { disabledPlugins, warnUnsandboxedMcpServers } from "./config-selection.ts";
import { writeStderr } from "./output.ts";

/**
 * 流式读取的静默上限（毫秒）。
 *
 * 配置里写的是秒，0 表示不限；0 与省略都交给下游按「不设上限」处理，不在这里编一个默认值。
 */
function streamIdleTimeoutMs(config: Config): number | undefined {
	return config.streamIdleTimeout > 0 ? config.streamIdleTimeout * 1000 : undefined;
}

export function createClient(
	config: Config,
	provider: ProviderEntry,
	model: ModelEntry,
): ReturnType<LlmRegistry["create"]> {
	return createBuiltinLlmRegistry().create(
		provider,
		model,
		{
			maxRetries: config.maxRetries,
			baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
		},
		config.httpProxy,
		streamIdleTimeoutMs(config),
	);
}

/**
 * 建立压缩器。
 *
 * 上下文上限必须由使用者声明：providers.json 的 contextWindow 或 config.toml 的 context_window，
 * 两处都没有就不压缩，并且明确说出来——没有上限就没有「快满了」这回事，使用者会以为程序在管
 * 上下文，其实没有。
 */
export function createCompactor(
	config: Config,
	selection: ModelSelection,
): Compactor | undefined {
	const mainWindow = selection.model.contextWindow ?? config.contextWindow;
	if (mainWindow === undefined) {
		writeStderr(
			"No context window declared (providers.json sets no contextWindow, config.toml sets no context_window). " +
				"Context will not be compacted automatically this run.\n",
		);
		return undefined;
	}

	// 摘要用 compact_model；它省略时用主模型。两者都在同一个 provider 内，配置层已校验。
	// 摘要模型可能更小：规划按两者较小的窗口来，保证被摘要的那段不会超过摘要请求的上下文。
	const model = selection.compactModel ?? selection.model;
	const contextWindow = compactionWindow(
		mainWindow,
		model === selection.model ? undefined : model.contextWindow,
	);
	return new Compactor({
		client: createClient(config, selection.provider, model),
		provider: selection.provider.id,
		model,
		contextWindow,
		maxTokens: config.maxTokens,
		compactAt: config.compaction.compactAt,
		keepRecent: config.compaction.keepRecent,
		summaryTimeoutMs:
			config.compaction.summaryTimeout > 0 ? config.compaction.summaryTimeout * 1000 : undefined,
	});
}

/** Plan 模式下模型能看到的全部工具：只读探索加计划提交，没有 shell、编辑或子代理。 */
const PLAN_TOOL_NAMES = ["read", "ls", "find", "grep", "present_plan"] as const;

/** 按白名单收窄注册表；随包工具可能被配置禁用，缺失的名字直接跳过。 */
function planToolRegistry(registry: ToolRegistry): ToolRegistry {
	const names = PLAN_TOOL_NAMES.filter((name) => registry.get(name) !== undefined);
	return registry.only(...names);
}

/** 一次运行的驱动。交互模式每次提交都要新建一个：它的生命周期就是一轮对话。 */
export function createDriverFor(
	context: {
		readonly config: Config;
		readonly selection: ModelSelection;
		readonly compactor: Compactor | undefined;
		readonly contextTokens?: number;
		readonly planMode?: boolean;
	},
	shared: {
		readonly registry: ToolRegistry;
		readonly session: Session;
		readonly workspace: WorkspaceBoundary;
		readonly sandbox: SandboxView;
		/** 可用技能；每轮重新取，改完 SKILL.md 下一轮就生效 */
		readonly skills?: () => readonly PromptSkill[];
		/** 用户级与项目级规则；每轮重新读，改完 AGENTS.md 下一轮就生效 */
		readonly instructions?: () => readonly PromptInstruction[];
		/** 撤销后的一次性提示；由装配处保证只取一次 */
		readonly undoNotice?: () => string | undefined;
	},
	onEvent: AgentEventListener,
): TurnDriver {
	// 主对话与子代理共用同一个客户端：它们只是同一个端点的两次请求，客户端本身没有连接状态
	const client = createClient(context.config, context.selection.provider, context.selection.model);
	const available =
		context.planMode === true
			? planToolRegistry(shared.registry)
			: shared.registry.without("present_plan");
	// 子代理能改文件也能跑命令，Plan 模式下不挂载；普通模式仍按原样交给它自己的注册表
	const tools =
		context.planMode === true
			? available
			: available.withExtraTool(
					createSubagentTool({
						provider: context.selection.provider,
						model: context.selection.model,
						config: context.config,
						client,
						// 子代理不再派子代理，也不需要主对话的任务表：任务表只在主面板与主对话里显示
						tools: available.without("todo"),
						session: shared.session,
						maxSteps: context.config.maxTurns ?? DEFAULT_SUBAGENT_STEPS,
						contextWindow: context.selection.model.contextWindow ?? context.config.contextWindow,
						instructions: shared.instructions,
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
		...(shared.skills === undefined ? {} : { skills: shared.skills }),
		...(shared.instructions === undefined ? {} : { instructions: shared.instructions }),
		...(shared.undoNotice === undefined ? {} : { undoNotice: shared.undoNotice }),
		...(context.planMode === true ? { planMode: true } : {}),
		...(context.compactor === undefined ? {} : { compactor: context.compactor }),
		...(context.contextTokens === undefined ? {} : { contextTokens: context.contextTokens }),
	});
}

/** 审查模型省略时用主模型。它只是判断一次调用该不该放行，不需要额外配置。 */
export function createReviewer(
	config: Config,
	selection: ModelSelection,
	workRoot: string,
): ModelReviewer {
	const reviewModel = selection.reviewModel ?? selection.model;
	return new ModelReviewer({
		client: createClient(config, selection.provider, reviewModel),
		model: reviewModel.id,
		maxTokens: reviewModel.maxTokens ?? config.maxTokens,
		workspaceRoot: workRoot,
	});
}

/**
 * 装载外部插件。
 *
 * 放在随包插件之后：两者共用一份注册表，重名要在这里成为一条清楚的装载失败。只在启动时装
 * 一次——改完插件文件要重启进程，没有热重载。
 */
async function loadExternalPlugins(host: PluginHost): Promise<readonly PluginFailure[]> {
	return new ExternalPlugins({ directory: pluginsDir(), host }).load();
}

/**
 * 装配工具与插件管线。
 *
 * 交互与非交互共用这一段:注册表、核心工具、随包与外部插件、沙箱。审批门由调用方先按
 * 「有没有人可问」建好传进来;onStage 给交互模式挂启动计时的阶段标记。
 * 返回 null 表示沙箱起不来,原因已经写给使用者,调用方直接以失败退出。
 */
export async function assemblePipeline(options: {
	readonly config: Config;
	readonly workRoot: string;
	readonly policy: PermissionPolicy;
	readonly gate: PermissionGate;
	readonly jobs?: JobManager;
	readonly onMcpStatus?: (source: McpStatusSource) => void;
	readonly onStage?: (stage: string) => void;
}): Promise<{
	readonly registry: ToolRegistry;
	readonly host: PluginHost;
	readonly sandbox: SandboxView;
	readonly sandboxInfo: SandboxInfo;
	readonly sandboxWarnings: readonly string[];
} | null> {
	const { config, workRoot, policy, gate } = options;
	const registry = new ToolRegistry(new ResultSpiller(config.spillThreshold, spillDir()), gate);
	for (const tool of createCoreTools({ shellPath: config.shellPath, jobs: options.jobs })) {
		registry.register(tool, "core");
	}

	const host = new PluginHost(registry, policy);
	const failures = await host.load(
		bundledPlugins({
			cwd: workRoot,
			version: readVersion(),
			mcpServers: config.mcpServers,
			...(options.onMcpStatus === undefined ? {} : { onMcpStatus: options.onMcpStatus }),
		}).filter((plugin) => !disabledPlugins(config).has(plugin.name)),
	);
	for (const failure of failures) {
		// 插件加载失败只说一声：一个写坏的插件不该让整个程序起不来
		writeStderr(`Plugin ${failure.plugin} failed to load: ${failure.message}\n`);
	}
	options.onStage?.("plugins");
	reportExternalFailures(await loadExternalPlugins(host));
	options.onStage?.("external");

	try {
		const { sandbox, info, warnings } = createSandboxFor(config, workRoot, host);
		// 沙箱缺席时把哪些 MCP server 因此裸奔说出来:不说,使用者只会以为它们被拦着
		warnUnsandboxedMcpServers(config);
		return { registry, host, sandbox, sandboxInfo: info, sandboxWarnings: warnings };
	} catch (error) {
		writeStderr(`${describeError(error)}\n`);
		return null;
	}
}

function reportExternalFailures(failures: readonly PluginFailure[]): void {
	for (const failure of failures) {
		writeStderr(`External plugin ${failure.plugin} failed to load: ${failure.message}\n`);
	}
}

function createSandboxFor(
	config: Config,
	workRoot: string,
	host: PluginHost,
): { readonly sandbox: SandboxView; readonly info: SandboxInfo; readonly warnings: readonly string[] } {
	return createSandbox(config.sandbox, workRoot, host.backends());
}
