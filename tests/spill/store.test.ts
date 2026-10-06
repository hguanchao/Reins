import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SpillStore } from '../../src/spill/store.ts';
import { readTextFile } from '../../src/util/fsx.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('落盘存储', () => {
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('保存后可读回完整内容', async () => {
    const store = new SpillStore(join(dir, 'spill'));
    const text = '完整内容-'.repeat(1000);
    const { path } = await store.save(text, 'bash');
    assert.ok(path.includes('bash'));
    assert.equal(await readTextFile(path), text);
  });

  it('多次保存互不覆盖', async () => {
    const store = new SpillStore(join(dir, 'spill'));
    const first = await store.save('a');
    const second = await store.save('b');
    assert.notEqual(first.path, second.path);
  });
});
