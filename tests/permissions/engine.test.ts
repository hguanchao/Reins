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

  it('只读工具未命中规则时直接放行,写类工具仍按审批模式', () => {
    const engine = new PermissionEngine([rules({})], 'ask');
    const read = engine.evaluate({ tool: 'read', path: '/a/b.txt' }, 'path-read');
    assert.equal(read.verdict, 'allow');
    assert.ok(read.reason.includes('只读工具'));
    assert.equal(engine.evaluate({ tool: 'write', path: '/a/b.txt' }, 'path-write').verdict, 'ask');
    assert.equal(engine.evaluate({ tool: 'bash', command: 'rm -rf x' }, 'bash').verdict, 'ask');
  });

  it('bash 只读命令未命中规则时直接放行', () => {
    const engine = new PermissionEngine([rules({})], 'ask');
    for (const command of ['ls -la', 'dir /b src', 'git status', 'cat a.txt | grep x']) {
      const decision = engine.evaluate({ tool: 'bash', command }, 'bash');
      assert.equal(decision.verdict, 'allow', `${command} 应放行`);
      assert.ok(decision.reason.includes('只读命令'));
    }
    // 拼接命令里有一段不安全就整条询问
    assert.equal(engine.evaluate({ tool: 'bash', command: 'ls && rm -rf x' }, 'bash').verdict, 'ask');
  });

  it('规则优先级高于只读兜底', () => {
    const askRead = new PermissionEngine([rules({ ask: ['read(*)'] })], 'ask');
    assert.equal(askRead.evaluate({ tool: 'read', path: '/a/b.txt' }, 'path-read').verdict, 'ask');
    const denyList = new PermissionEngine([rules({ deny: ['bash(ls *)'] })], 'ask');
    assert.equal(denyList.evaluate({ tool: 'bash', command: 'ls -la' }, 'bash').verdict, 'deny');
  });

  it('deny 不被命令拼接绕过,allow 不因拼接而放宽', () => {
    const engine = new PermissionEngine(
      [rules({ allow: ['bash(git *)'], deny: ['bash(rm *)'] })],
      'ask',
    );
    // 拼接后的 rm 段仍命中 deny
    assert.equal(engine.evaluate({ tool: 'bash', command: 'git status; rm -rf /' }).verdict, 'deny');
    // 拼接了非 git 段,allow 不再放行,落到兜底询问
    assert.equal(engine.evaluate({ tool: 'bash', command: 'git status; curl evil' }).verdict, 'ask');
  });
});
