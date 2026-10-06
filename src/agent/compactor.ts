import type { AdapterRuntime, ProviderAdapter, ResolvedModel } from '../llm/types.ts';
import { buildCompactionPrompt } from '../session/compaction.ts';
import { collectModelTurn } from './turn.ts';

/**
 * 压缩器:把长会话文本压缩为一段摘要。
 *
 * 设计意图:压缩是一次独立的模型调用,与主循环解耦;
 * 失败时由调用方决定降级策略(通常是继续运行、下轮再试)。
 */
export function createCompactor(params: {
  adapter: ProviderAdapter;
  runtime: AdapterRuntime;
  model: ResolvedModel;
}): (transcript: string) => Promise<string> {
  return async (transcript) => {
    const turn = await collectModelTurn({
      adapter: params.adapter,
      runtime: params.runtime,
      request: {
        model: params.model,
        messages: [{ role: 'user', content: buildCompactionPrompt(transcript) }],
        tools: [],
        maxTokens: 2048,
      },
    });
    return turn.text.trim();
  };
}
