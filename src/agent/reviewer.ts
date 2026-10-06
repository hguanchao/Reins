import type { AdapterRuntime, ProviderAdapter, ResolvedModel } from '../llm/types.ts';
import type { Reviewer } from '../permissions/approval.ts';
import type { Decision } from '../permissions/engine.ts';
import type { RuleTarget } from '../permissions/rules.ts';
import { collectModelTurn } from './turn.ts';

/**
 * 审查模型:auto 模式下,把「ask 级」操作交给一次独立的模型调用裁决。
 *
 * 设计意图:审查器只能收紧、不能放宽——回复含糊、解析失败或调用异常
 * 一律保守拒绝;它只有两个出口:ALLOW 或 DENY。
 */
export function createReviewer(params: {
  adapter: ProviderAdapter;
  runtime: AdapterRuntime;
  model: ResolvedModel;
}): Reviewer {
  return {
    async review(target, decision) {
      try {
        const turn = await collectModelTurn({
          adapter: params.adapter,
          runtime: params.runtime,
          request: {
            model: params.model,
            messages: [{ role: 'user', content: buildReviewPrompt(target, decision) }],
            tools: [],
            maxTokens: 16,
          },
        });
        const text = turn.text.toLowerCase();
        if (text.includes('allow') && !text.includes('deny')) {
          return 'allow';
        }
        return 'deny';
      } catch {
        return 'deny';
      }
    },
  };
}

function buildReviewPrompt(target: RuleTarget, decision: Decision): string {
  const what = target.command ?? target.path ?? target.server ?? target.domain ?? '(未知目标)';
  return [
    '你是操作安全审查器。判断下面这次工具调用是否允许执行。',
    '只回答一个词:ALLOW 或 DENY。不要输出任何其他内容。',
    '',
    `工具:${target.tool}`,
    `目标:${what}`,
    `触发原因:${decision.reason}`,
  ].join('\n');
}
