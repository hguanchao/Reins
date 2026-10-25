import type { Config } from "../config/file.ts";
import type { ModelEntry } from "../config/providers-file.ts";
import type { LlmToolDeclaration } from "../llm/client.ts";
import { clampEffort } from "../llm/effort.ts";

/**
 * 主对话与子代理共用的请求拼装件。
 *
 * 输出上限、思考强度与工具声明的映射只写这一份:两处各拼一遍,口径迟早漂移。
 */

/** 会话里记录的工具声明或插件声明,映射成请求里的工具清单。 */
export function requestTools(
	tools: readonly {
		readonly name: string;
		readonly description: string;
		readonly parameters: unknown;
	}[],
): readonly LlmToolDeclaration[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

/** 输出上限与思考强度:模型声明优先,配置兜底,等级收敛到模型支持的那一档。 */
export function requestOptions(model: ModelEntry, config: Config): {
	readonly maxTokens: number | undefined;
	readonly effort: ReturnType<typeof clampEffort>;
} {
	return {
		maxTokens: model.maxTokens ?? config.maxTokens,
		effort: clampEffort(config.reasoningEffort, model.reasoning, model.thinkingLevelMap),
	};
}

/**
 * 被输出上限截断的工具调用不执行,统一回给模型这一句。
 *
 * 流式收到的参数可能只是前半截,拿去执行是危险的:一个被截断的路径或命令可能指向
 * 完全不同的东西。主对话与子代理都用同一条理由回复。
 */
export const TRUNCATED_TOOL_ARGUMENTS =
	"The previous response was cut off by the output limit, so its tool arguments may be incomplete;" +
	" this call was not executed. Split the work into smaller steps.";
