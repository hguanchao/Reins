import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GrepTool } from '../../src/tools/grep.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('内容搜索工具', () => {
  const tool = new GrepTool();
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'one.ts'), 'export const value = 42;\n');
    await writeFile(join(dir, 'two.md'), 'nothing here\n');
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('返回 file:line 格式的匹配', async () => {
    const result = await tool.execute({ pattern: 'value' }, { workspace: dir });
    assert.equal(result.isError, false);
    assert.ok(result.content.includes('src/one.ts:1'));
  });

  it('无匹配时给出明确结果', async () => {
    const result = await tool.execute({ pattern: '绝不存在的内容' }, { workspace: dir });
    assert.equal(result.isError, false);
    assert.ok(result.content.includes('未找到匹配'));
  });

  it('非法正则被拒绝', async () => {
    const result = await tool.execute({ pattern: '(' }, { workspace: dir });
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('正则'));
  });

  it('忽略大小写', async () => {
    const result = await tool.execute({ pattern: 'VALUE' }, { workspace: dir });
    assert.ok(result.content.includes('src/one.ts:1'));
  });
});
