import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { trustCommand } from '../../src/cli/commands/trust.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('trust 子命令', () => {
  let home = '';
  let target = '';
  const previous = process.env['REINS_HOME'];

  function capture(): { out: string[]; err: string[] } {
    return { out: [], err: [] };
  }

  async function run(...positionals: string[]): Promise<{ code: number; out: string; err: string }> {
    const lines = capture();
    const code = await trustCommand(
      { command: 'trust', positionals, flags: {} },
      { out: (t) => void lines.out.push(t), err: (t) => void lines.err.push(t) },
    );
    return { code, out: lines.out.join('\n'), err: lines.err.join('\n') };
  }

  before(async () => {
    home = await createTmpDir();
    target = await createTmpDir();
    process.env['REINS_HOME'] = home;
    await writeFile(join(home, 'config.toml'), 'provider = "p"\nmodel = "m"\n');
  });

  after(async () => {
    if (previous === undefined) {
      delete process.env['REINS_HOME'];
    } else {
      process.env['REINS_HOME'] = previous;
    }
    await removeTmpDir(home);
    await removeTmpDir(target);
  });

  it('空列表时给出授权方法', async () => {
    const result = await run('list');
    assert.equal(result.code, 0);
    assert.ok(result.out.includes('尚未信任任何项目'));
    assert.ok(result.out.includes('[trust].trusted'));
  });

  it('add 写入绝对路径并保持幂等', async () => {
    const first = await run('add', target);
    assert.equal(first.code, 0);
    assert.ok(first.out.includes('已信任'));
    const text = await readFile(join(home, 'config.toml'), 'utf8');
    assert.ok(text.includes('[trust]'));
    assert.ok(text.includes(target.replace(/\\/g, '\\')));
    // 重复添加不产生第二份
    await run('add', target);
    const again = await readFile(join(home, 'config.toml'), 'utf8');
    assert.equal(again, text);
    // list 能看到
    assert.ok((await run('list')).out.includes(target));
  });

  it('remove 撤销', async () => {
    const removed = await run('remove', target);
    assert.equal(removed.code, 0);
    assert.ok(removed.out.includes('已撤销'));
    assert.ok((await run('list')).out.includes('尚未信任任何项目'));
  });

  it('缺目录参数与未知动作都报用法', async () => {
    const missing = await run('add');
    assert.equal(missing.code, 1);
    assert.ok(missing.err.includes('用法'));
    const unknown = await run('grant', target);
    assert.equal(unknown.code, 1);
    assert.ok(unknown.err.includes('未知子命令'));
  });
});
