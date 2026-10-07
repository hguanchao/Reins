import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { discoverProjectDoc, existingProjectDocs } from '../../src/context/agents-md.ts';
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

describe('说明文件清单(信任页用)', () => {
  it('按优先级列出存在的文件,不读内容', async () => {
    const dir = await createTmpDir();
    try {
      await writeFile(join(dir, 'AGENTS.md'), 'a');
      await writeFile(join(dir, 'REINS.md'), 'b');
      assert.deepEqual(await existingProjectDocs(dir), [join(dir, 'REINS.md'), join(dir, 'AGENTS.md')]);
    } finally {
      await removeTmpDir(dir);
    }
  });

  it('都没有时返回空列表', async () => {
    const dir = await createTmpDir();
    try {
      assert.deepEqual(await existingProjectDocs(dir), []);
    } finally {
      await removeTmpDir(dir);
    }
  });

  it('同名的目录不算说明文件', async () => {
    const dir = await createTmpDir();
    try {
      await mkdir(join(dir, 'AGENTS.md'), { recursive: true });
      assert.deepEqual(await existingProjectDocs(dir), []);
    } finally {
      await removeTmpDir(dir);
    }
  });
});
