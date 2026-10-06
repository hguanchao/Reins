import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { absolutize, displayPath, expandHome, isWithin, reinsHome } from '../../src/util/paths.ts';

describe('路径工具', () => {
  it('展开 ~', () => {
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('~/a/b'), join(homedir(), 'a/b'));
    assert.equal(expandHome('relative/path'), 'relative/path');
  });

  it('absolutize 以基准目录解析相对路径', () => {
    const base = join(homedir(), 'workspace');
    assert.equal(absolutize('src/a.ts', base), join(base, 'src/a.ts'));
    assert.equal(absolutize('a/../b', base), join(base, 'b'));
  });

  it('isWithin 判断包含关系', () => {
    const root = join(homedir(), 'workspace');
    assert.equal(isWithin(root, join(root, 'src', 'a.ts')), true);
    assert.equal(isWithin(root, root), true);
    assert.equal(isWithin(root, join(homedir(), 'elsewhere')), false);
    assert.equal(isWithin(root, join(root, '..', 'sibling')), false);
  });

  it('displayPath 使用正斜杠', () => {
    const base = join(homedir(), 'workspace');
    assert.equal(displayPath(join(base, 'src', 'a.ts'), base), 'src/a.ts');
    assert.equal(displayPath(base, base), '.');
  });

  it('reinsHome 支持环境变量覆盖', () => {
    const previous = process.env.REINS_HOME;
    try {
      process.env.REINS_HOME = join(homedir(), 'custom-reins');
      assert.equal(reinsHome(), join(homedir(), 'custom-reins'));
      delete process.env.REINS_HOME;
      assert.equal(reinsHome(), join(homedir(), '.reins'));
    } finally {
      if (previous === undefined) {
        delete process.env.REINS_HOME;
      } else {
        process.env.REINS_HOME = previous;
      }
    }
  });
});
