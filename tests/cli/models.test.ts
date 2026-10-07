import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { modelsCommand } from '../../src/cli/commands/models.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

function captureLines(): { lines: string[]; io: { out: (t: string) => void; err: (t: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { out: (t) => void lines.push(t), err: (t) => void lines.push(t) } };
}

describe('models 子命令', () => {
  let home = '';

  before(async () => {
    home = await createTmpDir();
    await writeFile(
      join(home, 'providers.json'),
      JSON.stringify({
        providers: {
          demo: {
            baseUrl: 'https://demo.example/v1',
            api: 'openai-completions',
            models: [{ id: 'm1', contextWindow: 1000 }],
          },
        },
      }),
    );
  });

  after(async () => {
    await removeTmpDir(home);
  });

  it('列出产商与模型', async () => {
    const { lines, io } = captureLines();
    const code = await modelsCommand({ command: 'models', positionals: ['list'], flags: {} }, io, home);
    assert.equal(code, 0);
    const all = lines.join('\n');
    assert.ok(all.includes('demo(openai-completions'));
    assert.ok(all.includes('- m1 [ctx 1000]'));
  });

  it('过滤不存在的 provider 时报错', async () => {
    const { lines, io } = captureLines();
    const code = await modelsCommand(
      { command: 'models', positionals: ['list'], flags: { provider: 'nope' } },
      io,
      home,
    );
    assert.equal(code, 1);
    assert.ok(lines.join('').includes('未找到'));
  });
});
