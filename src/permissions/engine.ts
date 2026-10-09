import type { ApprovalMode, PermissionRules } from '../config/schema.ts';
import type { PermissionKind } from '../tools/registry.ts';
import { parseRule, type ParsedRule, type RuleTarget } from './rules.ts';
import { isReadOnlyCommand } from './safe-commands.ts';

/**
 * 策略引擎:把规则表变成对单次调用的裁决。
 *
 * 设计意图:跨层按 deny > ask > allow 求值——先看所有层的 deny,再 ask,再 allow;
 * 同类别内先命中先定论。没有命中任何规则时按工具性质兜底:只读工具与只读命令直接
 * 放行,其余按审批模式(ask 模式询问,auto / yolo 放行)。兜底只管「没写规则」的情况,
 * 想收回写一条 deny 或 ask 规则即可——规则优先级永远高于兜底。
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

  /** 对一次调用给出裁决;kind 是工具的性质,只用于未命中规则时的兜底。 */
  evaluate(target: RuleTarget, kind?: PermissionKind): Decision {
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
    return this.fallbackFor(target, kind);
  }

  /**
   * 未命中任何规则时的兜底裁决。
   *
   * 只读工具不改变系统状态,只读命令(ls、cat、git status…)同理,而且每次调用都进
   * 会话记录、审计不丢;逐条审批只会让人闭着眼按 y,把真正危险的审批淹掉。
   */
  private fallbackFor(target: RuleTarget, kind: PermissionKind | undefined): Decision {
    if (kind === 'path-read') {
      return { verdict: 'allow', reason: '只读工具,未命中任何规则,直接放行' };
    }
    if (kind === 'bash' && target.command !== undefined && isReadOnlyCommand(target.command)) {
      return { verdict: 'allow', reason: '只读命令,未命中任何规则,直接放行' };
    }
    return {
      verdict: this.fallback,
      reason: this.fallback === 'ask' ? '未命中任何规则,按审批模式询问' : '未命中任何规则,按审批模式放行',
    };
  }
}
