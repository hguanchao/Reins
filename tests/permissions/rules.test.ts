import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/util/errors.ts';
import { parseRule } from '../../src/permissions/rules.ts';

describe('权限规则', () => {
  it('格式非法时报错', () => {
    assert.throws(() => parseRule('bash('), ConfigError);
    assert.throws(() => parseRule('(x)'), ConfigError);
  });

  it('bash 命令按 shell 通配匹配', () => {
    const rule = parseRule('bash(rm *)');
    assert.equal(rule.match({ tool: 'bash', command: 'rm -rf build' }), true);
    assert.equal(rule.match({ tool: 'bash', command: 'npm test' }), false);
    assert.equal(rule.match({ tool: 'read', path: '/tmp/x' }), false);
  });

  it('末尾的 " *" 表示可带任意参数,不带参数也命中', () => {
    const rule = parseRule('bash(git push *)');
    assert.equal(rule.match({ tool: 'bash', command: 'git push' }), true);
    assert.equal(rule.match({ tool: 'bash', command: 'git push origin main' }), true);
    assert.equal(rule.match({ tool: 'bash', command: 'git pushx' }), false);
  });

  it('路径规则支持 ~ 展开与 ** 递归', () => {
    const rule = parseRule('read(~/.ssh/**)');
    assert.equal(rule.match({ tool: 'read', path: join(homedir(), '.ssh', 'id_rsa') }), true);
    assert.equal(rule.match({ tool: 'read', path: join(homedir(), '.ssh', 'nested', 'key') }), true);
    assert.equal(rule.match({ tool: 'read', path: join(homedir(), '.aws', 'credentials') }), false);
  });

  it('不含分隔符的路径规则按文件名兜底', () => {
    const rule = parseRule('read(*.env)');
    assert.equal(rule.match({ tool: 'read', path: join(homedir(), 'proj', 'sub', '.env') }), true);
    assert.equal(rule.match({ tool: 'read', path: join(homedir(), 'proj', 'main.ts') }), false);
  });

  it('通配符不跨目录分隔符', () => {
    const rule = parseRule('write(src/*.ts)');
    const root = join(homedir(), 'proj');
    assert.equal(rule.match({ tool: 'write', path: join(root, 'src', 'a.ts') }), true);
    assert.equal(rule.match({ tool: 'write', path: join(root, 'src', 'deep', 'a.ts') }), false);
  });

  it('相对路径模式在任意层级按后缀匹配', () => {
    const rule = parseRule('write(src/*.ts)');
    const root = join(homedir(), 'proj');
    assert.equal(rule.match({ tool: 'write', path: join(root, 'nested', 'src', 'a.ts') }), true);
  });

  it('web_fetch 域名不区分大小写', () => {
    const rule = parseRule('web_fetch(domain:*.internal.example)');
    assert.equal(rule.match({ tool: 'web_fetch', domain: 'API.INTERNAL.EXAMPLE' }), true);
    assert.equal(rule.match({ tool: 'web_fetch', domain: 'example.com' }), false);
  });

  it('mcp 按 server 名匹配', () => {
    const rule = parseRule('mcp(context7)');
    assert.equal(rule.match({ tool: 'mcp', server: 'context7' }), true);
    assert.equal(rule.match({ tool: 'mcp', server: 'other' }), false);
  });

  it('空括号规则匹配该工具的全部调用', () => {
    const rule = parseRule('bash()');
    assert.equal(rule.match({ tool: 'bash', command: 'anything' }), true);
  });
});
