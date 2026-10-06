import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { discoverProjectDoc } from '../../src/context/agents-md.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('项目文档发现', () => {
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('都没有时返回 null', async () => {
    assert.equal(await discoverProjectDoc(dir), null);
  });

  it('优先 REINS.md', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'AGENTS 内容');
    await writeFile(join(dir, 'REINS.md'), 'REINS 内容');
    const doc = await discoverProjectDoc(dir);
    assert.equal(doc?.content, 'REINS 内容');
  });

  it('只发现 AGENTS.md 时使用它', async () => {
    const isolated = await createTmpDir();
    try {
      await writeFile(join(isolated, 'AGENTS.md'), '仅 AGENTS');
      const doc = await discoverProjectDoc(isolated);
      assert.equal(doc?.content, '仅 AGENTS');
    } finally {
      await removeTmpDir(isolated);
    }
  });

  it('超长文档被截断', async () => {
    const isolated = await createTmpDir();
    try {
      await writeFile(join(isolated, 'REINS.md'), 'x'.repeat(100));
      const doc = await discoverProjectDoc(isolated, { maxChars: 10 });
      assert.ok(doc?.content.startsWith('x'.repeat(10)));
      assert.ok(doc?.content.includes('已截断'));
    } finally {
      await removeTmpDir(isolated);
    }
  });
});
