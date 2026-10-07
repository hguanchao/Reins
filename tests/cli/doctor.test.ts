import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { doctorCommand } from '../../src/cli/commands/doctor.ts';
import { FAKE_MCP_SERVER_SOURCE } from '../helpers/fake-mcp-server.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

function captureLines(): { lines: string[]; io: { out: (t: string) => void; err: (t: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { out: (t) => void lines.push(t), err: (t) => void lines.push(t) } };
}

describe('doctor 子命令', () => {
  let home = '';
  /** 干净工作区:不指向仓库,免得把 Reins 自己的 AGENTS.md 当成被忽略的内容。 */
  let workspace = '';

  before(async () => {
    home = await createTmpDir();
    workspace = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(home);
    await removeTmpDir(workspace);
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
      { command: 'doctor', positionals: [], flags: { 'no-network': true, workspace } },
      io,
      home,
    );
    assert.equal(code, 0);
    assert.ok(lines.join('\n').includes('一切正常'));
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
      { command: 'doctor', positionals: [], flags: { 'no-network': true, workspace } },
      io,
      home,
    );
    assert.equal(code, 1);
    assert.ok(lines.join('\n').includes('没有名为 "m1" 的模型'));
  });

  it('MCP server 连接状态被报告', async () => {
    const fakeDir = await createTmpDir();
    try {
      const script = join(fakeDir, 'fake-server.js');
      await writeFile(script, FAKE_MCP_SERVER_SOURCE);
      const command = process.execPath.replace(/\\/g, '/');
      const scriptPath = script.replace(/\\/g, '/');
      await writeFile(
        join(home, 'config.toml'),
        [
          'provider = "demo"',
          'model = "m1"',
          '',
          '[mcp_servers.fake]',
          `command = "${command}"`,
          `args = ["${scriptPath}"]`,
          '',
        ].join('\n'),
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
        { command: 'doctor', positionals: [], flags: { 'no-network': true, workspace } },
        io,
        home,
      );
      assert.equal(code, 0);
      assert.ok(lines.join('\n').includes('MCP fake:1 个工具'));
    } finally {
      await removeTmpDir(fakeDir);
    }
  });

  it('未信任目录里有项目内容时报为问题,授权后消失', async () => {
    await writeFile(join(home, 'config.toml'), 'provider = "demo"\nmodel = "m1"\n');
    await writeFile(join(workspace, 'AGENTS.md'), '# 项目规范\n');
    try {
      const first = captureLines();
      assert.equal(
        await doctorCommand(
          { command: 'doctor', positionals: [], flags: { 'no-network': true, workspace } },
          first.io,
          home,
        ),
        1,
      );
      assert.ok(first.lines.join('\n').includes('AGENTS.md 未加载'));

      // 把该目录写进 [trust].trusted 后,同一份工作区应当一切正常
      await writeFile(
        join(home, 'config.toml'),
        `provider = "demo"\nmodel = "m1"\n\n[trust]\ntrusted = ['${workspace}']\n`,
      );
      const second = captureLines();
      assert.equal(
        await doctorCommand(
          { command: 'doctor', positionals: [], flags: { 'no-network': true, workspace } },
          second.io,
          home,
        ),
        0,
      );
      assert.ok(second.lines.join('\n').includes('项目层已加载'));
    } finally {
      await removeTmpDir(join(workspace, 'AGENTS.md'));
    }
  });
});
