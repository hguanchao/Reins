import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApprovalGate, type Approver, type Reviewer } from '../../src/permissions/approval.ts';
import type { Decision } from '../../src/permissions/engine.ts';

const askDecision: Decision = { verdict: 'ask', rule: 'bash(git push *)', reason: '命中规则' };
const target = { tool: 'bash', command: 'git push origin main' } as const;

describe('审批门', () => {
  it('yolo 直接放行', async () => {
    const gate = new ApprovalGate('yolo');
    const result = await gate.decide(target, askDecision);
    assert.equal(result.verdict, 'allow');
  });

  it('auto 交由审查模型裁决', async () => {
    const seen: string[] = [];
    const reviewer: Reviewer = {
      async review(_target, decision) {
        seen.push(decision.rule ?? '');
        return 'deny';
      },
    };
    const gate = new ApprovalGate('auto', { reviewer });
    const result = await gate.decide(target, askDecision);
    assert.equal(result.verdict, 'deny');
    assert.deepEqual(seen, ['bash(git push *)']);
  });

  it('auto 缺少审查模型时保守拒绝', async () => {
    const gate = new ApprovalGate('auto');
    const result = await gate.decide(target, askDecision);
    assert.equal(result.verdict, 'deny');
  });

  it('ask 模式交由人工通道', async () => {
    const approver: Approver = { async ask() { return 'allow'; } };
    const gate = new ApprovalGate('ask', { approver });
    assert.equal((await gate.decide(target, askDecision)).verdict, 'allow');
  });

  it('ask 模式无通道时保守拒绝', async () => {
    const gate = new ApprovalGate('ask');
    assert.equal((await gate.decide(target, askDecision)).verdict, 'deny');
  });

  it('非 ask 裁决原样通过', async () => {
    const gate = new ApprovalGate('ask');
    const deny: Decision = { verdict: 'deny', reason: '规则拒绝' };
    assert.equal((await gate.decide(target, deny)).verdict, 'deny');
  });
});
