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
 * 记的都是「前缀」而不是整条目标:命中规则时记规则本身(那条规则覆盖的都能放行);
 * bash 记命令前缀——记整条命令等于没记(换个参数又问一次),记首词又太宽
 * (`git` 会把 push 一起放行);带路径的工具记所在目录——同一目录下换个文件
 * 不该再问一遍。给不出前缀时才退回整条目标,只对完全相同的调用生效。
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
  const dir = directoryPrefix(target.path);
  if (dir !== undefined) {
    return { key: `${target.tool}:${dir}*`, scope: `${dir}*` };
  }
  return { key: `${target.tool}:${target.path ?? target.server ?? target.domain ?? ''}` };
}

/** 目录前缀:路径最后一个分隔符之前的部分(含分隔符);根目录下或没有路径时给不出。 */
function directoryPrefix(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? undefined : path.slice(0, cut + 1);
}

/**
 * 人工审批的结论。
 *
 * 拒绝时可以附一句理由:它会随裁决的 reason 进入工具结果,让模型知道该怎么改,
 * 而不是只看到"被拒绝"再猜一次。
 */
export interface ApprovalAnswer {
  verdict: 'allow' | 'deny';
  /** 拒绝理由;用户没写时省略。 */
  reason?: string;
}

/** 人工审批通道(交互界面提供)。 */
export interface Approver {
  /** preview 是工具给出的改动预览(审批前让人看清批的是什么)。 */
  ask(target: RuleTarget, decision: Decision, preview?: readonly string[]): Promise<ApprovalAnswer>;
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
  private current: ApprovalMode;
  readonly approver: Approver | undefined;
  readonly reviewer: Reviewer | undefined;

  constructor(mode: ApprovalMode, options: ApprovalGateOptions = {}) {
    this.current = mode;
    this.approver = options.approver;
    this.reviewer = options.reviewer;
  }

  get mode(): ApprovalMode {
    return this.current;
  }

  /**
   * 会话内切换审批模式。
   *
   * 不重建运行时:重建会断掉 MCP 连接、清掉当前回合,而模式只影响后续裁决。
   */
  setMode(mode: ApprovalMode): void {
    this.current = mode;
  }

  /** 非 ask 裁决原样通过;ask 裁决按模式处理。 */
  async decide(target: RuleTarget, decision: Decision, preview?: readonly string[]): Promise<Decision> {
    if (decision.verdict !== 'ask') {
      return decision;
    }
    if (this.current === 'yolo') {
      return { verdict: 'allow', rule: decision.rule, reason: 'yolo:自动放行' };
    }
    if (this.current === 'auto') {
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
    const answer = await this.approver.ask(target, decision, preview);
    const note = answer.reason !== undefined && answer.reason !== '' ? `(${answer.reason})` : '';
    return { verdict: answer.verdict, rule: decision.rule, reason: `人工审批:${answer.verdict}${note}` };
  }
}
