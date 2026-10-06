import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PermissionRules } from '../../src/config/schema.ts';
import { PermissionEngine } from '../../src/permissions/engine.ts';

function rules(partial: Partial<PermissionRules>): PermissionRules {
  return { deny: [], ask: [], allow: [], ...partial };
}

describe('策略引擎', () => {
  it('deny 优先于 allow', () => {
    const engine = new PermissionEngine(
      [rules({ allow: ['bash(git *)'], deny: ['bash(git push *)'] })],
      'ask',
    );
    assert.equal(
      engine.evaluate({ tool: 'bash', command: 'git push origin main' }).verdict,
      'deny',
    );
    assert.equal(engine.evaluate({ tool: 'bash', command: 'git status' }).verdict, 'allow');
  });

  it('ask 优先于 allow', () => {
    const engine = new PermissionEngine(
      [rules({ ask: ['bash(git push *)'], allow: ['bash(git *)'] })],
      'ask',
    );
    assert.equal(engine.evaluate({ tool: 'bash', command: 'git push' }).verdict, 'ask');
  });

  it('同类别内先命中先定论', () => {
    const engine = new PermissionEngine(
      [rules({ deny: ['bash(rm *)', 'bash(rm -rf *)'] })],
      'ask',
    );
    const decision = engine.evaluate({ tool: 'bash', command: 'rm -rf x' });
    assert.equal(decision.rule, 'bash(rm *)');
  });

  it('跨层按层序求值', () => {
    const engine = new PermissionEngine(
      [rules({ deny: ['bash(cmd-a *)'] }), rules({ deny: ['bash(cmd-b *)'] })],
      'ask',
    );
    assert.equal(engine.evaluate({ tool: 'bash', command: 'cmd-b x' }).verdict, 'deny');
  });

  it('未命中时按审批模式兜底', () => {
    const target = { tool: 'bash', command: 'ls' } as const;
    assert.equal(new PermissionEngine([rules({})], 'ask').evaluate(target).verdict, 'ask');
    assert.equal(new PermissionEngine([rules({})], 'auto').evaluate(target).verdict, 'allow');
    assert.equal(new PermissionEngine([rules({})], 'yolo').evaluate(target).verdict, 'allow');
  });
});
