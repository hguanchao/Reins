import {
	APPROVAL_MODES,
	SANDBOX_MODES,
	type ApprovalMode,
	type Config,
	type McpServerConfig,
	type SandboxMode,
} from "./config-file.ts";
import { ConfigFile } from "./config-file.ts";
import { ConfigError } from "./config-error.ts";
import type { ProvidersConfig, ProviderEntry } from "./providers-file.ts";

/**
 * 合并用户级与项目级配置。
 *
 * 三条规则，理由各不相同：
 *
 * 一、普通的项由项目覆盖用户。项目配置的意义就在这里——同一个仓库里的协作方共用一套设置。
 *
 * 二、涉及安全姿态的项只能加严。项目配置来自工作区，而工作区可能是别人给的；允许它把审批
 *     放宽到 yolo，等于让一个目录在没人同意的情况下取消所有确认。
 *
 * 三、信任清单只在用户级生效。让项目声明自己可信，「不受信任的目录影响不了程序」这句话就
 *     不成立了。
 *
 * 判断「项目写没写某项」用的是原文里有没有这个键，而不是最终值：只看最终值会把「项目没写、
 * 取了默认值」误当成「项目要求用默认值」，从而盖掉用户的设置。
 */

const APPROVAL_STRICTNESS: Readonly<Record<ApprovalMode, number>> = { yolo: 0, auto: 1, ask: 2 };
const SANDBOX_STRICTNESS: Readonly<Record<SandboxMode, number>> = { off: 0, workspace: 1, "read-only": 2 };

export function mergeConfigs(user: ConfigFile, project: ConfigFile): Config {
	const pick = <T>(path: readonly string[], fromUser: T, fromProject: T): T =>
		project.has(path) ? fromProject : fromUser;

	return {
		provider: pick(["provider"], user.config.provider, project.config.provider),
		model: pick(["model"], user.config.model, project.config.model),
		reasoningEffort: pick(
			["reasoning_effort"],
			user.config.reasoningEffort,
			project.config.reasoningEffort,
		),
		contextWindow: pick(["context_window"], user.config.contextWindow, project.config.contextWindow),
		maxTokens: pick(["max_tokens"], user.config.maxTokens, project.config.maxTokens),
		maxRetries: pick(["max_retries"], user.config.maxRetries, project.config.maxRetries),
		streamIdleTimeout: pick(
			["stream_idle_timeout"],
			user.config.streamIdleTimeout,
			project.config.streamIdleTimeout,
		),
		httpProxy: pick(["httpProxy"], user.config.httpProxy, project.config.httpProxy),
		shellPath: pick(["shellPath"], user.config.shellPath, project.config.shellPath),
		compactModel: pick(["compact_model"], user.config.compactModel, project.config.compactModel),
		reviewModel: pick(["review_model"], user.config.reviewModel, project.config.reviewModel),
		approval: pickStricterApproval(user, project),
		sandbox: pickStricterSandbox(user, project),
		maxTurns: pick(["max_turns"], user.config.maxTurns, project.config.maxTurns),
		spillThreshold: pick(["spill_threshold"], user.config.spillThreshold, project.config.spillThreshold),
		compaction: {
			compactAt: pick(
				["compaction", "compact_at"],
				user.config.compaction.compactAt,
				project.config.compaction.compactAt,
			),
			keepRecent: pick(
				["compaction", "keep_recent"],
				user.config.compaction.keepRecent,
				project.config.compaction.keepRecent,
			),
			summaryTimeout: pick(
				["compaction", "summary_timeout"],
				user.config.compaction.summaryTimeout,
				project.config.compaction.summaryTimeout,
			),
		},
		ui: {
			notify: pick(["ui", "notify"], user.config.ui.notify, project.config.ui.notify),
		},
		mcpServers: mergeMcpServers(user.config.mcpServers, project.config.mcpServers),
		plugins: {
			// 两边都列出的都停用：项目可以多关掉一个插件，但不能把用户关掉的重新打开
			disabled: unique([...user.config.plugins.disabled, ...project.config.plugins.disabled]),
			trusted: user.config.plugins.trusted,
		},
	};
}

function pickStricterApproval(user: ConfigFile, project: ConfigFile): ApprovalMode {
	if (!project.has(["approval"])) return user.config.approval;
	const wanted = project.config.approval;
	if (APPROVAL_STRICTNESS[wanted] < APPROVAL_STRICTNESS[user.config.approval]) {
		throw new ConfigError(
			`Project config cannot relax approval from ${user.config.approval} to ${wanted}; it may only tighten (available: ${APPROVAL_MODES.join(", ")})`,
			{ file: project.file, ...project.locationOf(["approval"]) },
		);
	}
	return wanted;
}

function pickStricterSandbox(user: ConfigFile, project: ConfigFile): SandboxMode {
	if (!project.has(["sandbox"])) return user.config.sandbox;
	const wanted = project.config.sandbox;
	if (SANDBOX_STRICTNESS[wanted] < SANDBOX_STRICTNESS[user.config.sandbox]) {
		throw new ConfigError(
			`Project config cannot relax sandbox from ${user.config.sandbox} to ${wanted}; it may only tighten (available: ${SANDBOX_MODES.join(", ")})`,
			{ file: project.file, ...project.locationOf(["sandbox"]) },
		);
	}
	return wanted;
}

/** 同名条目以项目为准，其余按名字补上。 */
function mergeMcpServers(
	user: readonly McpServerConfig[],
	project: readonly McpServerConfig[],
): readonly McpServerConfig[] {
	const merged = user.map((server) => project.find((item) => item.name === server.name) ?? server);
	for (const server of project) {
		if (!merged.some((item) => item.name === server.name)) merged.push(server);
	}
	return merged;
}

/**
 * 合并两份模型配置。
 *
 * 同名的 provider 整体替换而不是逐字段合并：半新半旧的 provider 定义很难看出最终长什么样，
 * 而 provider 本身就相当于一个整体（端点、协议、密钥、模型清单是一套的）。
 */
export function mergeProviders(user: ProvidersConfig, project: ProvidersConfig): ProvidersConfig {
	const merged: ProviderEntry[] = user.providers.map(
		(provider) => project.providers.find((item) => item.id === provider.id) ?? provider,
	);
	for (const provider of project.providers) {
		if (!merged.some((item) => item.id === provider.id)) merged.push(provider);
	}
	return { providers: merged };
}

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)];
}
