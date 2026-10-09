import type { ApprovalMode, PermissionRules } from '../config/schema.ts';
import { parseRule, type ParsedRule, type RuleTarget } from './rules.ts';

/**
 * 策略引擎:把规则表变成对单次调用的裁决。
 *
 * 设计意图:跨层按 deny > ask > allow 求值——先看所有层的 deny,
 * 再 ask,再 allow;同类别内先命中先定论。没有命中任何规则时,
 * 按审批模式给出兜底裁决(ask 模式询问,auto / yolo 放行)。
 */

export type Verdict = 'allow' | 'ask' | 'deny';

export interface Decision {
  verdict: Verdict;
  /** 命中的规则原文;兜底裁决时为空。 */
  rule?: string;
  reason: string;
}

export class PermissionEngine {
  readonly deny: ParsedRule[];
  readonly ask: ParsedRule[];
  readonly allow: ParsedRule[];
  readonly fallback: Verdict;

  constructor(layers: PermissionRules[], approval: ApprovalMode) {
    this.deny = layers.flatMap((layer) => layer.deny).map(parseRule);
    this.ask = layers.flatMap((layer) => layer.ask).map(parseRule);
    this.allow = layers.flatMap((layer) => layer.allow).map(parseRule);
    this.fallback = approval === 'ask' ? 'ask' : 'allow';
  }

  /** 对一次调用给出裁决。 */
  evaluate(target: RuleTarget): Decision {
    const categories: { verdict: Verdict; rules: ParsedRule[] }[] = [
      { verdict: 'deny', rules: this.deny },
      { verdict: 'ask', rules: this.ask },
      { verdict: 'allow', rules: this.allow },
    ];
    for (const category of categories) {
      for (const rule of category.rules) {
        if (rule.tool === target.tool && rule.match(target, category.verdict)) {
          return { verdict: category.verdict, rule: rule.raw, reason: `命中规则 ${rule.raw}` };
        }
      }
    }
    return {
      verdict: this.fallback,
      reason: this.fallback === 'ask' ? '未命中任何规则,按审批模式询问' : '未命中任何规则,按审批模式放行',
    };
  }
}
