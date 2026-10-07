import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EditTool } from '../../src/tools/edit.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('编辑工具', () => {
  const tool = new EditTool();
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('唯一匹配时精确替换', async () => {
    const file = join(dir, 'edit1.txt');
    await writeFile(file, 'hello world');
    const result = await tool.execute(
      { path: 'edit1.txt', oldText: 'world', newText: 'reins' },
      { workspace: dir },
    );
    assert.equal(result.isError, false);
    assert.equal(await readFile(file, 'utf8'), 'hello reins');
  });

  it('未找到时拒绝修改', async () => {
    const file = join(dir, 'edit2.txt');
    await writeFile(file, 'abc');
    const result = await tool.execute(
      { path: 'edit2.txt', oldText: 'zzz', newText: 'x' },
      { workspace: dir },
    );
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('未找到'));
    assert.equal(await readFile(file, 'utf8'), 'abc');
  });

  it('多处匹配时拒绝修改', async () => {
    const file = join(dir, 'edit3.txt');
    await writeFile(file, 'a a');
    const result = await tool.execute(
      { path: 'edit3.txt', oldText: 'a', newText: 'b' },
      { workspace: dir },
    );
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('不唯一'));
    assert.equal(await readFile(file, 'utf8'), 'a a');
  });

  it('替换文本里的 $ 不被当作替换模式展开', async () => {
    const file = join(dir, 'edit4.txt');
    await writeFile(file, 'let price = 0;');
    const result = await tool.execute(
      { path: 'edit4.txt', oldText: '0', newText: '$$' },
      { workspace: dir },
    );
    assert.equal(result.isError, false);
    assert.equal(await readFile(file, 'utf8'), 'let price = $$;');
  });

  it('CRLF 文件的多行替换也能命中,且写回仍是 CRLF', async () => {
    const file = join(dir, 'edit5.txt');
    await writeFile(file, 'hello\r\nworld\r\n');
    // read 工具按 \r?\n 拆行,模型给出的 oldText 一律是 \n
    const result = await tool.execute(
      { path: 'edit5.txt', oldText: 'hello\nworld', newText: 'hello\nreins' },
      { workspace: dir },
    );
    assert.equal(result.isError, false);
    assert.equal(await readFile(file, 'utf8'), 'hello\r\nreins\r\n');
  });
});
