import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { globToRegExp, shellGlobMatch } from '../../src/util/glob.ts';

describe('通配匹配原语', () => {
  it('shell 风格:* 跨分隔符', () => {
    assert.equal(shellGlobMatch('rm *', 'rm -rf build'), true);
    assert.equal(shellGlobMatch('rm *', 'rmdir x'), false);
  });

  it('shell 风格:末尾 " *" 允许无参数', () => {
    assert.equal(shellGlobMatch('git push *', 'git push'), true);
    assert.equal(shellGlobMatch('git push *', 'git push origin main'), true);
    assert.equal(shellGlobMatch('git push *', 'git pushx'), false);
  });

  it('路径风格:**/ 匹配零个或多个路径段', () => {
    const regex = globToRegExp('src/**/*.ts', { crossSeparator: false });
    assert.equal(regex.test('src/a.ts'), true);
    assert.equal(regex.test('src/a/b.ts'), true);
    assert.equal(regex.test('lib/a.ts'), false);
  });

  it('路径风格:单个 * 不跨分隔符', () => {
    const regex = globToRegExp('src/*.ts', { crossSeparator: false });
    assert.equal(regex.test('src/a.ts'), true);
    assert.equal(regex.test('src/deep/a.ts'), false);
  });

  it('支持忽略大小写与 ? 单字符', () => {
    const regex = globToRegExp('A?C', { crossSeparator: true, caseInsensitive: true });
    assert.equal(regex.test('abc'), true);
    assert.equal(regex.test('abbc'), false);
  });
});
