import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { doctorCommand } from '../../src/cli/commands/doctor.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

function captureLines(): { lines: string[]; io: { out: (t: string) => void; err: (t: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { out: (t) => void lines.push(t), err: (t) => void lines.push(t) } };
}

describe('doctor 子命令', () => {
  let home = '';
  const previous = process.env['REINS_HOME'];

  before(async () => {
    home = await createTmpDir();
    process.env['REINS_HOME'] = home;
  });

  after(async () => {
    if (previous === undefined) {
      delete process.env['REINS_HOME'];
    } else {
      process.env['REINS_HOME'] = previous;
    }
    await removeTmpDir(home);
  });

  it('全部就绪时返回 0', async () => {
    await writeFile(
      join(home, 'config.toml'),
      ['provider = "demo"', 'model = "m1"', ''].join('\n'),
    );
    await writeFile(
      join(home, 'providers.json'),
      JSON.stringify({
        providers: {
          demo: {
            baseUrl: 'https://demo.example/v1',
            api: 'openai-completions',
            apiKey: 'k',
            models: [{ id: 'm1', contextWindow: 8000 }],
          },
        },
      }),
    );
    const { lines, io } = captureLines();
    const code = await doctorCommand(
      { command: 'doctor', positionals: [], flags: { 'no-network': true } },
      io,
    );
    assert.equal(code, 0);
    assert.ok(lines.join('\n').includes('一切正常'));
  });

  it('协议未实现时报出问题', async () => {
    await writeFile(
      join(home, 'providers.json'),
      JSON.stringify({
        providers: {
          demo: {
            baseUrl: 'https://demo.example/v1',
            api: 'google-generative-ai',
            apiKey: 'k',
            models: [{ id: 'm1', contextWindow: 8000 }],
          },
        },
      }),
    );
    const { lines, io } = captureLines();
    const code = await doctorCommand(
      { command: 'doctor', positionals: [], flags: { 'no-network': true } },
      io,
    );
    assert.equal(code, 1);
    assert.ok(lines.join('\n').includes('尚未实现'));
  });

  it('模型不存在时报出问题', async () => {
    await writeFile(
      join(home, 'providers.json'),
      JSON.stringify({
        providers: {
          demo: {
            baseUrl: 'https://demo.example/v1',
            api: 'openai-completions',
            apiKey: 'k',
            models: [{ id: 'other', contextWindow: 8000 }],
          },
        },
      }),
    );
    const { lines, io } = captureLines();
    const code = await doctorCommand(
      { command: 'doctor', positionals: [], flags: { 'no-network': true } },
      io,
    );
    assert.equal(code, 1);
    assert.ok(lines.join('\n').includes('没有名为 "m1" 的模型'));
  });
});
