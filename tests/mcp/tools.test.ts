import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpManager } from '../../src/mcp/servers.ts';
import { registerMcpTools } from '../../src/mcp/tools.ts';
import { PermissionEngine } from '../../src/permissions/engine.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { FAKE_MCP_SERVER_SOURCE } from '../helpers/fake-mcp-server.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('MCP 工具桥接', () => {
  let dir = '';
  let manager: McpManager;
  let registry: ToolRegistry;

  before(async () => {
    dir = await createTmpDir();
    const script = join(dir, 'fake-server.js');
    await writeFile(script, FAKE_MCP_SERVER_SOURCE);
    manager = new McpManager({ fake: { command: process.execPath, args: [script] } });
    await manager.connectAll();
    registry = new ToolRegistry();
    registerMcpTools(registry, manager);
  });

  after(async () => {
    await manager.close();
    await removeTmpDir(dir);
  });

  it('注册为 mcp__server__tool 且可执行', async () => {
    const tool = registry.get('mcp__fake__echo');
    assert.ok(tool !== undefined);
    assert.deepEqual(tool.targetOf({}, { workspace: process.cwd() }), { server: 'fake' });
    const result = await tool.execute({ text: 'abc' }, { workspace: process.cwd() });
    assert.equal(result.content, 'echo:abc');
    assert.equal(result.isError, false);
  });

  it('权限规则以 mcp(server) 匹配', () => {
    const tool = registry.get('mcp__fake__echo');
    assert.ok(tool !== undefined);
    const engine = new PermissionEngine([{ deny: [], ask: [], allow: ['mcp(fake)'] }], 'ask');
    const decision = engine.evaluate({ tool: tool.ruleToolName ?? tool.name, server: 'fake' });
    assert.equal(decision.verdict, 'allow');
    const unmatched = engine.evaluate({ tool: 'mcp', server: 'other' });
    assert.equal(unmatched.verdict, 'ask');
  });
});
