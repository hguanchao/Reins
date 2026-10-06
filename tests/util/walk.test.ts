import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';
import { walkFiles } from '../../src/util/walk.ts';

describe('目录遍历', () => {
  let root = '';

  before(async () => {
    root = await createTmpDir();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    await writeFile(join(root, 'README.md'), '# demo\n');
  });

  after(async () => {
    await removeTmpDir(root);
  });

  it('跳过被忽略目录并保持稳定顺序', async () => {
    const found: string[] = [];
    for await (const file of walkFiles(root)) {
      found.push(file.replace(`${root}\\`, '').replace(`${root}/`, '').split(/[\\/]/).join('/'));
    }
    assert.deepEqual(found.sort(), ['README.md', 'src/a.ts', 'src/b.ts']);
  });

  it('支持中止', async () => {
    const controller = new AbortController();
    controller.abort();
    const found: string[] = [];
    for await (const file of walkFiles(root, { signal: controller.signal })) {
      found.push(file);
    }
    assert.equal(found.length, 0);
  });
});
