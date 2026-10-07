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
  const what = target.command ?? target.path ?? target.server ?? target.domain ?? '(unknown target)';
  return [
    'You are a tool-call authorization reviewer. Decide whether the single tool call below may execute.',
    '',
    'Answer with exactly one word: ALLOW or DENY. Output nothing else.',
    '',
    'Judge by what the call will actually do, not by the tool name or the stated intent. Allow routine, project-local, reversible work. Deny anything destructive, irreversible, or reaching beyond the workspace, and anything touching credentials, secrets, or remote systems. When the effect is unclear, deny.',
    '',
    `Tool: ${target.tool}`,
    `Target: ${what}`,
    `Triggered rule: ${decision.reason}`,
  ].join('\n');
}
