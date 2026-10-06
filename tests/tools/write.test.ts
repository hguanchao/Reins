import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WriteTool } from '../../src/tools/write.ts';
import { readTextFile } from '../../src/util/fsx.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('写入工具', () => {
  const tool = new WriteTool();
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('写入文件并自动创建父目录', async () => {
    const result = await tool.execute(
      { path: 'deep/nested/new.txt', content: '你好' },
      { workspace: dir },
    );
    assert.equal(result.isError, false);
    assert.equal(await readTextFile(join(dir, 'deep', 'nested', 'new.txt')), '你好');
  });

  it('允许写入空内容', async () => {
    const result = await tool.execute({ path: 'empty.txt', content: '' }, { workspace: dir });
    assert.equal(result.isError, false);
  });

  it('缺少 content 参数时报错', async () => {
    const result = await tool
      .execute({ path: 'x.txt' }, { workspace: dir })
      .catch((error: unknown) => ({ content: String(error), isError: true }));
    assert.equal(result.isError, true);
  });
});
