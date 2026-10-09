import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvalGrant, ApprovalGate, type Approver, type Reviewer } from '../../src/permissions/approval.ts';
import type { Decision } from '../../src/permissions/engine.ts';

const askDecision: Decision = { verdict: 'ask', rule: 'bash(git push *)', reason: '命中规则' };
const target = { tool: 'bash', command: 'git push origin main' } as const;

describe('会话内总是允许的范围', () => {
  const fallback: Decision = { verdict: 'ask', reason: '未命中任何规则,按审批模式询问' };

  it('命中规则时记规则本身', () => {
    assert.deepEqual(approvalGrant(target, askDecision), {
      key: 'bash(git push *)',
      scope: 'bash(git push *)',
    });
  });

  it('bash 记命令前缀而不是整条命令', () => {
    // 记整条命令等于没记:换个参数又问一次
    assert.deepEqual(approvalGrant({ tool: 'bash', command: 'dir /b codex-rs\\src' }, fallback), {
      key: 'bash:dir *',
      scope: 'dir *',
    });
    // 多词命令带上子命令,`git` 记成 `git status` 才不会连 push 一起放行
    assert.deepEqual(approvalGrant({ tool: 'bash', command: 'git status --short' }, fallback), {
      key: 'bash:git status *',
      scope: 'git status *',
    });
  });

  it('拼接命令不记前缀,只对同一条命令生效', () => {
    // 否则 `ls && rm -rf x` 记住 `ls *` 之后,`ls && rm -rf y` 也不再问
    assert.deepEqual(approvalGrant({ tool: 'bash', command: 'ls && rm -rf x' }, fallback), {
      key: 'bash:ls && rm -rf x',
    });
  });

  it('其余工具记具体目标', () => {
    assert.equal(approvalGrant({ tool: 'write', path: '/a/b.txt' }, fallback).key, 'write:/a/b.txt');
    assert.equal(approvalGrant({ tool: 'mcp', server: 'svc' }, fallback).key, 'mcp:svc');
    assert.equal(approvalGrant({ tool: 'fetch', domain: 'x.com' }, fallback).key, 'fetch:x.com');
  });
});

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
