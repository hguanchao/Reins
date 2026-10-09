import type { ApprovalMode } from '../config/schema.ts';
import type { Decision } from './engine.ts';
import type { RuleTarget } from './rules.ts';
import { commandPrefix } from './safe-commands.ts';

/**
 * 审批门:把「ask 裁决」转化为最终结论。
 *
 * 设计意图:三种审批模式各有明确语义——
 * - ask:交互式询问用户;
 * - auto:交由审查模型裁决(未配置 review_model 时保守拒绝);
 * - yolo:直接放行。
 * 没有可用通道时一律「保守拒绝」,保证非交互场景不会静默扩权。
 */

/** 会话内「总是允许」记下的授权范围。 */
export interface ApprovalGrant {
  /** 用于比对后续请求的键。 */
  key: string;
  /** 展示给用户的授权范围;没有可展示的范围时为空。 */
  scope?: string;
}

/**
 * 算一次「总是允许」要记住的范围。
 *
 * 命中规则时记规则本身(那条规则覆盖的都能放行);bash 记命令前缀——记整条命令
 * 等于没记(换个参数又问一次),记首词又太宽(`git` 会把 push 一起放行);
 * 其余工具记具体目标。给不出前缀时退回整条命令,只对完全相同的调用生效。
 */
export function approvalGrant(target: RuleTarget, decision: Decision): ApprovalGrant {
  if (decision.rule !== undefined) {
    return { key: decision.rule, scope: decision.rule };
  }
  if (target.command !== undefined) {
    const prefix = commandPrefix(target.command);
    if (prefix !== undefined) {
      return { key: `bash:${prefix} *`, scope: `${prefix} *` };
    }
    return { key: `bash:${target.command}` };
  }
  return { key: `${target.tool}:${target.path ?? target.server ?? target.domain ?? ''}` };
}

/** 人工审批通道(交互界面提供)。 */
export interface Approver {
  ask(target: RuleTarget, decision: Decision): Promise<'allow' | 'deny'>;
}

/** 审查模型通道(auto 模式提供)。 */
export interface Reviewer {
  review(target: RuleTarget, decision: Decision): Promise<'allow' | 'deny'>;
}

export interface ApprovalGateOptions {
  approver?: Approver;
  reviewer?: Reviewer;
}

export class ApprovalGate {
  readonly mode: ApprovalMode;
  readonly approver: Approver | undefined;
  readonly reviewer: Reviewer | undefined;

  constructor(mode: ApprovalMode, options: ApprovalGateOptions = {}) {
    this.mode = mode;
    this.approver = options.approver;
    this.reviewer = options.reviewer;
  }

  /** 非 ask 裁决原样通过;ask 裁决按模式处理。 */
  async decide(target: RuleTarget, decision: Decision): Promise<Decision> {
    if (decision.verdict !== 'ask') {
      return decision;
    }
    if (this.mode === 'yolo') {
      return { verdict: 'allow', rule: decision.rule, reason: 'yolo:自动放行' };
    }
    if (this.mode === 'auto') {
      if (this.reviewer === undefined) {
        return {
          verdict: 'deny',
          rule: decision.rule,
          reason: 'auto 模式未配置 review_model,保守拒绝',
        };
      }
      const verdict = await this.reviewer.review(target, decision);
      return { verdict, rule: decision.rule, reason: `auto:审查模型裁决为 ${verdict}` };
    }
    if (this.approver === undefined) {
      return {
        verdict: 'deny',
        rule: decision.rule,
        reason: '需要人工审批但没有可用的交互通道,保守拒绝',
      };
    }
    const verdict = await this.approver.ask(target, decision);
    return { verdict, rule: decision.rule, reason: `人工审批:${verdict}` };
  }
}
