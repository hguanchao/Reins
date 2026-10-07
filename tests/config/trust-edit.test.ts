import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addTrustPattern, removeTrustPattern, tomlString } from '../../src/config/trust-edit.ts';
import { ConfigError } from '../../src/util/errors.ts';

const BASE = ['provider = "demo"', 'model = "m"', '', '# 这是注释', '[ui]', 'theme = "dark"'].join('\n') + '\n';

describe('信任记录定点编辑', () => {
  it('没有 [trust] 段时在末尾追加,原有内容与注释逐字保留', () => {
    const next = addTrustPattern(BASE, 'E:/Projects/Reins');
    assert.equal(
      next,
      `${BASE}\n[trust]\ntrusted = ['E:/Projects/Reins']\n`,
    );
    assert.ok(next.includes('# 这是注释'));
  });

  it('单行数组只重写那一行', () => {
    const text = "[trust]\ntrusted = ['a']\n";
    assert.equal(addTrustPattern(text, 'b'), "[trust]\ntrusted = ['a', 'b']\n");
  });

  it('多行数组在收尾 ] 前插一行,保留用户的多行风格', () => {
    const text = '[trust]\ntrusted = [\n  \'a\',\n]\n';
    assert.equal(addTrustPattern(text, 'b'), '[trust]\ntrusted = [\n  \'a\',\n  \'b\',\n]\n');
  });

  it('已存在时原样返回(幂等)', () => {
    const text = "[trust]\ntrusted = ['a']\n";
    assert.equal(addTrustPattern(text, 'a'), text);
    assert.equal(addTrustPattern(addTrustPattern(text, 'b'), 'b'), addTrustPattern(text, 'b'));
  });

  it('段存在但没有 trusted 键时,紧跟段头插入', () => {
    const text = '[trust]\n# 占位注释\n\n[ui]\ntheme = "dark"\n';
    assert.equal(
      addTrustPattern(text, 'a'),
      '[trust]\ntrusted = [\'a\']\n# 占位注释\n\n[ui]\ntheme = "dark"\n',
    );
  });

  it('段内的其他键与注释不受影响', () => {
    const text = '[trust]\n# 说明\nother = 1\ntrusted = [\n  \'a\',\n]\n\n[mcp_servers.x]\ncommand = "y"\n';
    const next = addTrustPattern(text, 'b');
    assert.ok(next.includes('# 说明'));
    assert.ok(next.includes('other = 1'));
    assert.ok(next.includes('[mcp_servers.x]\ncommand = "y"'));
    assert.equal(next, '[trust]\n# 说明\nother = 1\ntrusted = [\n  \'a\',\n  \'b\',\n]\n\n[mcp_servers.x]\ncommand = "y"\n');
  });

  it('移除:单行与多行都只动那一处', () => {
    assert.equal(removeTrustPattern("[trust]\ntrusted = ['a', 'b']\n", 'a'), "[trust]\ntrusted = ['b']\n");
    assert.equal(
      removeTrustPattern("[trust]\ntrusted = [\n  'a',\n  'b',\n]\n", 'a'),
      "[trust]\ntrusted = [\n  'b',\n]\n",
    );
    // 不存在时原样返回
    const text = "[trust]\ntrusted = ['a']\n";
    assert.equal(removeTrustPattern(text, 'zzz'), text);
  });

  it('路径里的反斜杠用字面串,不必转义', () => {
    assert.equal(tomlString('E:\\Projects\\Reins'), "'E:\\Projects\\Reins'");
    const next = addTrustPattern(BASE, 'E:\\Projects\\Reins');
    assert.ok(next.includes("trusted = ['E:\\Projects\\Reins']"));
  });

  it('路径含单引号时退化为基本串并转义,且能被移除', () => {
    const weird = "C:/Users/O'Brien/repo";
    assert.equal(tomlString(weird), '"C:/Users/O\'Brien/repo"');
    const text = addTrustPattern(BASE, weird);
    assert.ok(text.includes(`trusted = ["${weird}"]`));
    assert.equal(removeTrustPattern(text, weird), `${BASE}\n[trust]\ntrusted = []\n`);
  });

  it('保留 CRLF 行尾', () => {
    const text = 'provider = "demo"\r\nmodel = "m"\r\n';
    const next = addTrustPattern(text, 'a');
    assert.equal(next, 'provider = "demo"\r\nmodel = "m"\r\n\r\n[trust]\r\ntrusted = [\'a\']\r\n');
    assert.equal(next.includes('\n\n'), false, '不应混入 LF 空行');
  });

  it('内联表与坏语法都报出可读错误', () => {
    assert.throws(
      () => addTrustPattern("provider = 'p'\ntrust = { trusted = ['a'] }\n", 'b'),
      (error: unknown) => error instanceof ConfigError && error.message.includes('内联表'),
    );
    assert.throws(
      () => addTrustPattern('provider = = "p"\n', 'a'),
      (error: unknown) => error instanceof ConfigError && error.message.includes('解析失败'),
    );
    assert.throws(
      () => addTrustPattern("[trust]\ntrusted = 'not-array'\n", 'a'),
      (error: unknown) => error instanceof ConfigError && error.message.includes('字符串数组'),
    );
  });
});
