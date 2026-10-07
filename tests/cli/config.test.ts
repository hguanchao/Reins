import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configCommand } from '../../src/cli/commands/config.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('config 子命令', () => {
  let home = '';

  before(async () => {
    home = await createTmpDir();
    await writeFile(
      join(home, 'config.toml'),
      ['provider = "demo"', 'model = "m1"', '', '[permissions]', 'deny = ["bash(rm *)"]', ''].join('\n'),
    );
  });

  after(async () => {
    await removeTmpDir(home);
  });

  it('check 通过时输出摘要', async () => {
    const lines: string[] = [];
    const code = await configCommand(
      { command: 'config', positionals: ['check'], flags: {} },
      { out: (t) => void lines.push(t), err: (t) => void lines.push(t) },
      home,
    );
    assert.equal(code, 0);
    assert.ok(lines.join('\n').includes('配置有效'));
    assert.ok(lines.join('\n').includes('provider=demo'));
  });

  it('show 打印解析后的 JSON:stdout 是纯 JSON,信任状态走 stderr', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await configCommand(
      { command: 'config', positionals: ['show'], flags: {} },
      { out: (t) => void out.push(t), err: (t) => void err.push(t) },
      home,
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
    assert.equal(parsed['provider'], 'demo');
    assert.deepEqual((parsed['permissions'] as Record<string, unknown>)['deny'], ['bash(rm *)']);
    // 信任说明不得混进 stdout,否则管道里的 JSON 解析会失败
    assert.ok(err.join('\n').includes('信任'));
  });

  it('非法配置返回错误码', async () => {
    const broken = await createTmpDir();
    try {
      await writeFile(join(broken, 'config.toml'), 'provider = "demo"\napproval = "whatever"\n');
      const lines: string[] = [];
      const code = await configCommand(
        { command: 'config', positionals: ['check'], flags: {} },
        { out: (t) => void lines.push(t), err: (t) => void lines.push(t) },
        broken,
      );
      assert.equal(code, 1);
      assert.ok(lines.join('\n').includes('approval'));
    } finally {
      await removeTmpDir(broken);
    }
  });
});
