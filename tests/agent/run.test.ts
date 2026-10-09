import assert from 'node:assert/strict';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runTask } from '../../src/agent/run.ts';
import { parseCatalog } from '../../src/catalog/schema.ts';
import { parseConfig } from '../../src/config/schema.ts';
import { SilentUi } from '../../src/ui/printer.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolCallBody(args: Record<string, unknown>): string {
  return (
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'write', arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    }) +
    frame({
      choices: [{ finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }) +
    'data: [DONE]\n\n'
  );
}

describe('运行时组装(端到端)', () => {
  it('从配置解析到工具执行再到最终答复的完整链路', async () => {
    const workspace = await createTmpDir();
    const home = await createTmpDir();
    try {
      const config = parseConfig({
        provider: 'demo',
        model: 'm1',
        approval: 'yolo',
        spill_threshold: 0,
        max_retries: 0,
      });
      const catalog = parseCatalog({
        providers: {
          demo: {
            baseUrl: 'https://demo.example/v1',
            api: 'openai-completions',
            apiKey: 'k',
            models: [{ id: 'm1', contextWindow: 10000 }],
          },
        },
      });

      const firstBody = toolCallBody({ path: 'a.txt', content: '你好' });
      const secondBody =
        frame({ choices: [{ delta: { content: '完成' } }] }) +
        frame({
          choices: [{ finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        }) +
        'data: [DONE]\n\n';

      const bodies = [firstBody, secondBody];
      let calls = 0;
      const fakeFetch = (async () => {
        const body = bodies[calls] ?? (bodies[bodies.length - 1] as string);
        calls += 1;
        return new Response(body, { status: 200 });
      }) as typeof fetch;

      const { result, session } = await runTask('写个文件', {
        config,
        catalog,
        workspace,
        home,
        ui: new SilentUi(),
        fetchImpl: fakeFetch,
      });

      assert.equal(result.text, '完成');
      assert.equal(result.turns, 2);
      assert.equal(result.usage.inputTokens, 18);
      assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), '你好');
      assert.equal(calls, 2);
      assert.ok(session.path.startsWith(home));
    } finally {
      await removeTmpDir(workspace);
      await removeTmpDir(home);
    }
  });

  it('auto 模式由审查模型放行 ask 级操作', async () => {
    const workspace = await createTmpDir();
    const home = await createTmpDir();
    try {
      const config = parseConfig({
        provider: 'demo',
        model: 'm1',
        approval: 'auto',
        spill_threshold: 0,
        max_retries: 0,
        permissions: { deny: [], ask: ['write(a.txt)'], allow: [] },
      });
      const catalog = parseCatalog({
        providers: {
          demo: {
            baseUrl: 'https://demo.example/v1',
            api: 'openai-completions',
            apiKey: 'k',
            models: [{ id: 'm1', contextWindow: 10000 }],
          },
        },
      });

      const bodies = [
        toolCallBody({ path: 'a.txt', content: '你好' }),
        frame({ choices: [{ delta: { content: 'ALLOW' } }] }) +
          frame({ choices: [{ finish_reason: 'stop' }] }) +
          'data: [DONE]\n\n',
        frame({ choices: [{ delta: { content: '完成' } }] }) +
          frame({ choices: [{ finish_reason: 'stop' }] }) +
          'data: [DONE]\n\n',
      ];
      let calls = 0;
      const fakeFetch = (async () => {
        const body = bodies[calls] ?? (bodies[bodies.length - 1] as string);
        calls += 1;
        return new Response(body, { status: 200 });
      }) as typeof fetch;

      const { result } = await runTask('写文件', {
        config,
        catalog,
        workspace,
        home,
        ui: new SilentUi(),
        fetchImpl: fakeFetch,
      });

      assert.equal(result.text, '完成');
      assert.equal(calls, 3);
      assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), '你好');
    } finally {
      await removeTmpDir(workspace);
      await removeTmpDir(home);
    }
  });

  it('工作区自身是符号链接时,区内的写入不被沙箱误判为越界', async () => {
    const real = await createTmpDir();
    const holder = await createTmpDir();
    const home = await createTmpDir();
    const workspace = join(holder, 'workspace-link');
    await symlink(real, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const config = parseConfig({
        provider: 'demo',
        model: 'm1',
        approval: 'yolo',
        sandbox: 'workspace',
        spill_threshold: 0,
        max_retries: 0,
      });
      const catalog = parseCatalog({
        providers: {
          demo: {
            baseUrl: 'https://demo.example/v1',
            api: 'openai-completions',
            apiKey: 'k',
            models: [{ id: 'm1', contextWindow: 10000 }],
          },
        },
      });

      const bodies = [
        toolCallBody({ path: 'a.txt', content: '你好' }),
        frame({ choices: [{ delta: { content: '完成' } }] }) +
          frame({ choices: [{ finish_reason: 'stop' }] }) +
          'data: [DONE]\n\n',
      ];
      let calls = 0;
      const fakeFetch = (async () => {
        const body = bodies[calls] ?? (bodies[bodies.length - 1] as string);
        calls += 1;
        return new Response(body, { status: 200 });
      }) as typeof fetch;

      const { result } = await runTask('写个文件', {
        config,
        catalog,
        workspace,
        home,
        ui: new SilentUi(),
        fetchImpl: fakeFetch,
      });

      assert.equal(result.text, '完成');
      // 沙箱按真实路径判定,链接指向的目录里的写入应当被放行
      assert.equal(await readFile(join(real, 'a.txt'), 'utf8'), '你好');
    } finally {
      await removeTmpDir(real);
      await removeTmpDir(holder);
      await removeTmpDir(home);
    }
  });
});
