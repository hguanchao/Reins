import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpManager } from '../../src/mcp/servers.ts';
import { FAKE_MCP_SERVER_SOURCE } from '../helpers/fake-mcp-server.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('MCP stdio 客户端', () => {
  let dir = '';
  let script = '';

  before(async () => {
    dir = await createTmpDir();
    script = join(dir, 'fake-server.js');
    await writeFile(script, FAKE_MCP_SERVER_SOURCE);
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('握手、列工具、调用工具全链路', async () => {
    const manager = new McpManager({ fake: { command: process.execPath, args: [script] } });
    try {
      const statuses = await manager.connectAll();
      assert.deepEqual(statuses, [{ name: 'fake', ok: true, toolCount: 1 }]);

      const tools = manager.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.server, 'fake');
      assert.equal(tools[0]?.tool.name, 'echo');

      const result = await manager.callTool('fake', 'echo', { text: '你好' });
      assert.equal(result.text, 'echo:你好');
      assert.equal(result.isError, false);
    } finally {
      await manager.close();
    }
  });

  it('连接失败进入状态清单而不抛出', async () => {
    const manager = new McpManager({ broken: { command: 'definitely-not-a-real-command-xyz' } });
    try {
      const statuses = await manager.connectAll();
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0]?.ok, false);
      assert.ok((statuses[0]?.error ?? '').length > 0);
    } finally {
      await manager.close();
    }
  });

  it('禁用 server 被跳过,未连接调用被拒绝', async () => {
    const manager = new McpManager({ off: { command: 'x', disabled: true } });
    try {
      const statuses = await manager.connectAll();
      assert.deepEqual(statuses, []);
      await assert.rejects(() => manager.callTool('off', 'echo', {}), /未连接/);
    } finally {
      await manager.close();
    }
  });
});

describe('MCP http 客户端', () => {
  it('通过注入的 fetch 完成请求/响应', async () => {
    const methods: string[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
      methods.push(message.method);
      let result: Record<string, unknown> = {};
      if (message.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: {} };
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] };
      } else if (message.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'pong' }] };
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const manager = new McpManager(
      { remote: { type: 'http', url: 'https://mcp.example/rpc' } },
      { fetchImpl: fakeFetch },
    );
    try {
      const statuses = await manager.connectAll();
      assert.deepEqual(statuses, [{ name: 'remote', ok: true, toolCount: 1 }]);

      const result = await manager.callTool('remote', 'ping', {});
      assert.equal(result.text, 'pong');
      assert.deepEqual([...methods].sort(), [
        'initialize',
        'notifications/initialized',
        'tools/call',
        'tools/list',
      ]);
    } finally {
      await manager.close();
    }
  });
});
