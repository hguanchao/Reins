import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { highlightCode } from '../../src/tui/highlight.ts';

function rolesOf(code: string, lang: string): string[][] {
  return highlightCode(code, lang).map((row) =>
    row.filter((token) => token.role !== undefined).map((token) => token.role as string),
  );
}

describe('代码高亮', () => {
  it('TypeScript:关键字、字符串、注释、函数各就各位', () => {
    const roles = rolesOf(
      ['// 注释', 'const name = "reins";', 'function run(x: number) {', '  return x;', '}'].join('\n'),
      'ts',
    );
    assert.ok(roles[0]?.includes('comment'));
    assert.ok(roles[1]?.includes('keyword'));
    assert.ok(roles[1]?.includes('string'));
    assert.ok(roles[2]?.includes('keyword'));
    assert.ok(roles[2]?.includes('function'));
    assert.ok(roles[2]?.includes('type'));
  });

  it('JSON:布尔与数字、字符串', () => {
    const roles = rolesOf('{"a": true, "b": 1.5}', 'json');
    assert.ok(roles[0]?.includes('string'));
    assert.ok(roles[0]?.includes('keyword'));
    assert.ok(roles[0]?.includes('number'));
  });

  it('Python:三引号字符串跨行延续', () => {
    const code = 'x = """第一行\n第二行"""\ny = 1';
    const rows = highlightCode(code, 'python');
    assert.ok(rows[0]?.every((token) => token.role !== 'comment'));
    assert.ok(rows[0]?.some((token) => token.role === 'string'));
    assert.ok(rows[1]?.some((token) => token.role === 'string'));
    assert.ok(rows[2]?.some((token) => token.role === 'number'));
  });

  it('Bash:井号注释', () => {
    const roles = rolesOf('echo hi # 说明', 'bash');
    assert.ok(roles[0]?.includes('comment'));
  });

  it('SQL:大小写不敏感关键字', () => {
    const roles = rolesOf('SELECT a FROM t WHERE x = 1', 'sql');
    assert.equal(roles[0]?.filter((role) => role === 'keyword').length, 3);
  });

  it('块注释跨行延续', () => {
    const roles = rolesOf('/* 开始\n结束 */ let x;', 'js');
    assert.ok(roles[0]?.includes('comment'));
    assert.ok(roles[1]?.includes('comment'));
    assert.ok(roles[1]?.includes('keyword'));
  });

  it('diff:增删行分类', () => {
    const roles = rolesOf(['@@ -1 +1 @@', '+added', '-removed', ' context'].join('\n'), 'diff');
    assert.ok(roles[0]?.includes('comment'));
    assert.ok(roles[1]?.includes('string'));
    assert.ok(roles[2]?.includes('keyword'));
    assert.deepEqual(roles[3], []);
  });

  it('未知语言原样返回,不改变文本', () => {
    const code = '任 意内容 123';
    const rows = highlightCode(code, 'no-such-lang');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.map((token) => token.text).join(''), code);
    assert.ok(rows[0]?.every((token) => token.role === undefined));
  });
});
