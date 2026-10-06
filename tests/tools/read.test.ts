import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ReadTool } from '../../src/tools/read.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('读取工具', () => {
  const tool = new ReadTool();
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
    await writeFile(join(dir, 'a.txt'), 'line1\nline2\nline3\n');
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('返回带行号内容', async () => {
    const result = await tool.execute({ path: 'a.txt' }, { workspace: dir });
    assert.equal(result.isError, false);
    assert.ok(result.content.includes('1│ line1'));
    assert.ok(result.content.includes('2│ line2'));
  });

  it('支持 offset/limit', async () => {
    const result = await tool.execute({ path: 'a.txt', offset: 2, limit: 1 }, { workspace: dir });
    assert.ok(result.content.includes('2│ line2'));
    assert.equal(result.content.includes('line1'), false);
    assert.equal(result.content.includes('line3'), false);
  });

  it('文件不存在时报错', async () => {
    const result = await tool.execute({ path: 'missing.txt' }, { workspace: dir });
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('文件不存在'));
  });

  it('targetOf 基于工作区解析路径', () => {
    const target = tool.targetOf({ path: 'a.txt' }, { workspace: dir });
    assert.equal(target.path, join(dir, 'a.txt'));
  });
});
