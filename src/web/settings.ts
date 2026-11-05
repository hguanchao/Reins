import {
	APPROVAL_MODES,
	THINKING_LEVELS,
	type ApprovalMode,
	type Config,
	type ThinkingLevel,
} from "#src/config/file.ts";
import type { ModelCost, ModelEntry, ProviderEntry } from "#src/config/providers-file.ts";
import type { ModelSelection } from "#src/config/selection.ts";
import { supportedEfforts } from "#src/llm/effort.ts";

/**
 * 设置页的数据面。
 *
 * 只暴露界面真正会用的字段；模型的能力（上下文窗口、思考等级、单价）一并带上，界面不必
 * 再回头查 providers.json。可写项只有能热更新的 effort 与 approval，其余项要重启进程，
 * 本轮只读展示。
 */

export interface SettingsModel {
	readonly provider: string;
	readonly providerName: string;
	readonly model: string;
	readonly name: string;
	readonly reasoning: boolean;
	readonly thinkingLevels: readonly ThinkingLevel[];
	readonly contextWindow: number | undefined;
	readonly maxTokens: number | undefined;
	readonly cost: ModelCost | undefined;
}

export interface SettingsSnapshot {
	readonly version: string;
	readonly configPath: string;
	readonly providersPath: string;
	readonly provider: string;
	readonly model: string;
	readonly effort: ThinkingLevel;
	readonly approval: ApprovalMode;
	readonly sandbox: string;
	readonly contextWindow: number | undefined;
	readonly maxTokens: number | undefined;
	readonly compactModel: string | undefined;
	readonly reviewModel: string | undefined;
	readonly models: readonly SettingsModel[];
	readonly mcpServers: readonly { readonly name: string; readonly type: string; readonly disabled: boolean }[];
	readonly plugins: readonly { readonly name: string; readonly kind: string; readonly disabled: boolean }[];
	readonly skills: readonly { readonly name: string; readonly description: string; readonly path: string }[];
}

export interface SettingsUpdate {
	readonly effort?: ThinkingLevel;
	readonly approval?: ApprovalMode;
}

export interface SettingsUpdateResult {
	readonly ok: boolean;
	readonly update?: SettingsUpdate;
	readonly error?: string;
}

export function describeSettings(input: {
	readonly version: string;
	readonly configPath: string;
	readonly providersPath: string;
	readonly config: Config;
	readonly selection: ModelSelection;
	readonly providers: readonly ProviderEntry[];
	readonly mcpServers: readonly { readonly name: string; readonly type: string; readonly disabled: boolean }[];
	readonly plugins: readonly { readonly name: string; readonly kind: string; readonly disabled: boolean }[];
	readonly skills: readonly { readonly name: string; readonly description: string; readonly path: string }[];
}): SettingsSnapshot {
	return {
		version: input.version,
		configPath: input.configPath,
		providersPath: input.providersPath,
		provider: input.selection.provider.id,
		model: input.selection.model.id,
		effort: input.config.reasoningEffort,
		approval: input.config.approval,
		sandbox: input.config.sandbox,
		contextWindow: input.selection.model.contextWindow ?? input.config.contextWindow,
		maxTokens: input.selection.model.maxTokens ?? input.config.maxTokens,
		compactModel: input.config.compactModel,
		reviewModel: input.config.reviewModel,
		models: input.providers.flatMap((provider) =>
			provider.models.map((model) => describeModel(provider, model)),
		),
		mcpServers: input.mcpServers,
		plugins: input.plugins,
		skills: input.skills,
	};
}

function describeModel(provider: ProviderEntry, model: ModelEntry): SettingsModel {
	return {
		provider: provider.id,
		providerName: provider.name,
		model: model.id,
		name: model.name,
		reasoning: model.reasoning,
		thinkingLevels: supportedEfforts(model.reasoning, model.thinkingLevelMap),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
	};
}

/**
 * 校验设置更新。
 *
 * 只接受两个可热更新的键；出现别的键时直接报错，而不是悄悄忽略——界面与后端对“哪些项能改”
 * 的认识一旦分叉，使用者会以为改动生效了。
 */
export function parseSettingsUpdate(body: Record<string, unknown>): SettingsUpdateResult {
	const unknown = Object.keys(body).filter((key) => key !== "effort" && key !== "approval");
	if (unknown.length > 0) return { ok: false, error: `Unsupported settings: ${unknown.join(", ")}` };

	const effort = body["effort"];
	const approval = body["approval"];
	if (effort === undefined && approval === undefined) {
		return { ok: false, error: "No settings to update" };
	}
	if (effort !== undefined) {
		if (typeof effort !== "string" || !THINKING_LEVELS.includes(effort as ThinkingLevel)) {
			return { ok: false, error: `effort must be one of: ${THINKING_LEVELS.join(", ")}` };
		}
	}
	if (approval !== undefined) {
		if (typeof approval !== "string" || !APPROVAL_MODES.includes(approval as ApprovalMode)) {
			return { ok: false, error: `approval must be one of: ${APPROVAL_MODES.join(", ")}` };
		}
	}

	return {
		ok: true,
		update: {
			...(effort === undefined ? {} : { effort: effort as ThinkingLevel }),
			...(approval === undefined ? {} : { approval: approval as ApprovalMode }),
		},
	};
}
