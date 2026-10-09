import assert from 'node:assert/strict';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Agent } from '../../src/agent/loop.ts';
import { parseConfig } from '../../src/config/schema.ts';
import type { AdapterRuntime, ProviderAdapter, StreamChunk, StreamRequest } from '../../src/llm/types.ts';
import { ApprovalGate, type Approver } from '../../src/permissions/approval.ts';
import { PermissionEngine } from '../../src/permissions/engine.ts';
import { Sandbox } from '../../src/permissions/sandbox.ts';
import { Session } from '../../src/session/tree.ts';
import type { SessionEntry, ToolResultEntry } from '../../src/session/store.ts';
import { SpillStore } from '../../src/spill/store.ts';
import { createDefaultRegistry } from '../../src/tools/defaults.ts';
import type { Tool, ToolRegistry } from '../../src/tools/registry.ts';
import { SilentUi } from '../../src/ui/printer.ts';
import { pathExists } from '../../src/util/fsx.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

class ScriptedAdapter implements ProviderAdapter {
  readonly api = 'openai-completions';
  readonly requests: StreamRequest[] = [];
  calls = 0;
  private readonly script: StreamChunk[][];

  constructor(script: StreamChunk[][]) {
    this.script = script;
  }

  async *stream(request: StreamRequest, _runtime: AdapterRuntime): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const chunks = this.script[this.calls] ?? [{ type: 'done', finishReason: 'stop' } as StreamChunk];
    this.calls += 1;
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}

const text = (value: string): StreamChunk => ({ type: 'text', text: value });
const done = (finishReason = 'stop'): StreamChunk => ({ type: 'done', finishReason });
const usage = (inputTokens: number, outputTokens: number): StreamChunk => ({
  type: 'usage',
  usage: { inputTokens, outputTokens },
});
const toolCall = (id: string, name: string, args: unknown): StreamChunk => ({
  type: 'tool_call',
  toolCall: { id, name, arguments: JSON.stringify(args) },
});

function isToolResult(entry: SessionEntry): entry is ToolResultEntry {
  return entry.type === 'tool_result';
}

interface AgentHarness {
  agent: Agent;
  session: Session;
  adapter: ScriptedAdapter;
  workspace: string;
  cleanup(): Promise<void>;
}

async function makeAgent(
  script: StreamChunk[][],
  options: {
    configRaw?: Record<string, unknown>;
    approver?: Approver;
    extraTools?: Tool[];
    compactor?: (transcript: string) => Promise<string>;
  } = {},
): Promise<AgentHarness> {
  const workspace = await createTmpDir();
  const home = await createTmpDir();
  const config = parseConfig({
    provider: 'demo',
    model: 'm1',
    approval: 'yolo',
    max_retries: 0,
    ...options.configRaw,
  });
  const session = await Session.create(join(home, 'sessions'), workspace);
  const registry: ToolRegistry = createDefaultRegistry();
  for (const tool of options.extraTools ?? []) {
    registry.register(tool);
  }
  const adapter = new ScriptedAdapter(script);
  const agent = new Agent({
    config,
    adapter,
    model: {
      provider: 'demo',
      id: 'm1',
      api: 'openai-completions',
      baseUrl: 'https://demo.example/v1',
      contextWindow: 10000,
      apiKey: 'k',
    },
    registry,
    session,
    engine: new PermissionEngine([config.permissions], config.approval),
    sandbox: new Sandbox(config.sandbox, workspace),
    approval: new ApprovalGate(config.approval, { approver: options.approver }),
    spill: new SpillStore(join(home, 'spill')),
    ui: new SilentUi(),
    workspace,
    systemPrompt: '测试系统提示',
    runtime: { maxRetries: 0 },
    compactor: options.compactor,
  });
  return {
    agent,
    session,
    adapter,
    workspace,
    cleanup: async () => {
      await removeTmpDir(workspace);
      await removeTmpDir(home);
    },
  };
}

describe('代理循环', () => {
  it('执行工具后能继续对话并给出最终答复', async () => {
    const harness = await makeAgent([
      [toolCall('c1', 'write', { path: 'a.txt', content: '你好' }), usage(10, 5), done('tool_calls')],
      [text('完成'), usage(8, 2), done()],
    ]);
    try {
      const result = await harness.agent.run('写个文件');
      assert.equal(result.text, '完成');
      assert.equal(result.turns, 2);
      assert.equal(result.usage.inputTokens, 18);
      assert.equal(await readFile(join(harness.workspace, 'a.txt'), 'utf8'), '你好');
      assert.deepEqual(
        harness.session.activeBranch().map((entry) => entry.type),
        ['user', 'assistant', 'tool_result', 'assistant'],
      );
    } finally {
      await harness.cleanup();
    }
  });

  it('ask 模式经人工通道审批后执行', async () => {
    const asked: string[] = [];
    const approver: Approver = {
      async ask(target) {
        asked.push(target.tool);
        return 'allow';
      },
    };
    const harness = await makeAgent(
      [
        [toolCall('c1', 'write', { path: 'a.txt', content: 'ok' }), done('tool_calls')],
        [text('完成'), done()],
      ],
      { configRaw: { approval: 'ask' }, approver },
    );
    try {
      await harness.agent.run('写文件');
      assert.deepEqual(asked, ['write']);
      assert.equal(await readFile(join(harness.workspace, 'a.txt'), 'utf8'), 'ok');
    } finally {
      await harness.cleanup();
    }
  });

  it('命中 deny 规则时拒绝执行并回传原因', async () => {
    const asked: string[] = [];
    const approver: Approver = {
      async ask(target) {
        asked.push(target.tool);
        return 'allow';
      },
    };
    const harness = await makeAgent(
      [
        [toolCall('c1', 'write', { path: 'blocked.txt', content: 'no' }), done('tool_calls')],
        [text('已处理'), done()],
      ],
      { configRaw: { approval: 'ask', permissions: { deny: ['write(blocked.txt)'] } }, approver },
    );
    try {
      const result = await harness.agent.run('尝试写敏感文件');
      assert.equal(result.text, '已处理');
      assert.equal(await pathExists(join(harness.workspace, 'blocked.txt')), false);
      assert.equal(asked.length, 0);
      const toolResult = harness.session
        .activeBranch()
        .find(isToolResult);
      assert.ok(toolResult !== undefined && toolResult.content.includes('操作被拒绝'));
    } finally {
      await harness.cleanup();
    }
  });

  it('工作区内的符号链接指向区外时被沙箱拦下', async () => {
    const harness = await makeAgent(
      [
        [toolCall('c1', 'write', { path: 'escape/secret.txt', content: 'no' }), done('tool_calls')],
        [text('已处理'), done()],
      ],
      { configRaw: { sandbox: 'workspace' } },
    );
    const outside = await createTmpDir();
    try {
      // 链接本身在工作区内,字面路径也就在工作区内,只有解析真实路径才看得出越界
      await symlink(outside, join(harness.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const result = await harness.agent.run('尝试绕过沙箱');
      assert.equal(result.text, '已处理');
      assert.equal(await pathExists(join(outside, 'secret.txt')), false);
      const toolResult = harness.session.activeBranch().find(isToolResult);
      assert.ok(toolResult !== undefined && toolResult.content.includes('sandbox = workspace'));
    } finally {
      await harness.cleanup();
      await removeTmpDir(outside);
    }
  });

  it('未知工具与坏参数都以结果形式回传', async () => {
    const harness = await makeAgent([
      [
        { type: 'tool_call', toolCall: { id: 'c1', name: 'nope', arguments: '{}' } },
        { type: 'tool_call', toolCall: { id: 'c2', name: 'read', arguments: '{bad json' } },
        done('tool_calls'),
      ],
      [text('收到'), done()],
    ]);
    try {
      await harness.agent.run('调用未知工具');
      const results = harness.session
        .activeBranch()
        .filter(isToolResult);
      assert.equal(results.length, 2);
      assert.ok(results[0]?.content.includes('未知工具'));
      assert.ok(results[1]?.content.includes('参数解析失败'));
    } finally {
      await harness.cleanup();
    }
  });

  it('超长结果落盘且上下文只留预览', async () => {
    const bigTool: Tool = {
      name: 'big',
      description: '返回超长内容',
      parameters: { type: 'object' },
      permissionKind: 'bash',
      targetOf: () => ({}),
      execute: async () => ({ content: 'x'.repeat(200), isError: false }),
    };
    const harness = await makeAgent(
      [
        [toolCall('c1', 'big', {}), done('tool_calls')],
        [text('结束'), done()],
      ],
      { configRaw: { spill_threshold: 16 }, extraTools: [bigTool] },
    );
    try {
      await harness.agent.run('跑大工具');
      const toolResult = harness.session
        .activeBranch()
        .find(isToolResult);
      assert.ok(toolResult !== undefined);
      assert.ok(toolResult.content.includes('已完整保存到'));
      const match = /已完整保存到:([^\n]+)/.exec(toolResult.content);
      assert.ok(match !== null);
      const savedPath = (match as RegExpExecArray)[1] as string;
      assert.equal(await pathExists(savedPath), true);
    } finally {
      await harness.cleanup();
    }
  });

  it('达到 max_turns 上限后停止', async () => {
    const harness = await makeAgent(
      [
        [toolCall('c1', 'write', { path: 'a.txt', content: '1' }), done('tool_calls')],
        [text('不该到达'), done()],
      ],
      { configRaw: { max_turns: 1 } },
    );
    try {
      const result = await harness.agent.run('循环任务');
      assert.equal(result.turns, 1);
      assert.equal(harness.adapter.calls, 1);
    } finally {
      await harness.cleanup();
    }
  });

  it('上下文接近上限时压缩为摘要,后续请求只带摘要', async () => {
    const transcripts: string[] = [];
    const harness = await makeAgent(
      [
        [
          toolCall('c1', 'write', { path: 'a.txt', content: '1' }),
          usage(8000, 5),
          done('tool_calls'),
        ],
        [text('结束'), usage(10, 1), done()],
      ],
      {
        compactor: async (transcript) => {
          transcripts.push(transcript);
          return '历史摘要内容';
        },
      },
    );
    try {
      const result = await harness.agent.run('长任务');
      assert.equal(result.text, '结束');
      assert.equal(transcripts.length, 1);
      assert.ok(transcripts[0]?.includes('长任务'));

      const secondRequest = harness.adapter.requests[1];
      assert.ok(secondRequest !== undefined);
      assert.equal(secondRequest.messages.length, 2);
      assert.ok(secondRequest.messages[1]?.content.includes('历史摘要内容'));
      assert.ok(harness.session.activeBranch().some((entry) => entry.type === 'summary'));
    } finally {
      await harness.cleanup();
    }
  });

  it('MCP 类工具的规则匹配使用 ruleToolName', async () => {
    const mcpishTool: Tool = {
      name: 'mcp__svc__ping',
      description: '伪 MCP 工具',
      parameters: { type: 'object' },
      permissionKind: 'mcp',
      ruleToolName: 'mcp',
      targetOf: () => ({ server: 'svc' }),
      execute: async () => ({ content: 'pong', isError: false }),
    };
    const harness = await makeAgent(
      [
        [
          { type: 'tool_call', toolCall: { id: 'c1', name: 'mcp__svc__ping', arguments: '{}' } },
          done('tool_calls'),
        ],
        [text('完成'), done()],
      ],
      {
        configRaw: { approval: 'ask', permissions: { deny: [], ask: [], allow: ['mcp(svc)'] } },
        approver: {
          async ask() {
            return 'deny';
          },
        },
        extraTools: [mcpishTool],
      },
    );
    try {
      const result = await harness.agent.run('调用 MCP');
      assert.equal(result.text, '完成');
      const toolResult = harness.session.activeBranch().find(isToolResult);
      assert.equal(toolResult?.content, 'pong');
    } finally {
      await harness.cleanup();
    }
  });

  it('信号已中止时不发起模型调用', async () => {
    const harness = await makeAgent([[text('不该到达'), done()]]);
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await harness.agent.run('任务', { signal: controller.signal });
      assert.equal(result.turns, 0);
      assert.equal(harness.adapter.calls, 0);
      assert.ok(
        harness.session
          .activeBranch()
          .some((entry) => entry.type === 'assistant' && entry.text === '(已中断)'),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it('工具中触发中止后不再进入下一轮', async () => {
    const controller = new AbortController();
    const abortTool: Tool = {
      name: 'abort-now',
      description: '触发中止',
      parameters: { type: 'object' },
      permissionKind: 'bash',
      targetOf: () => ({}),
      execute: async () => {
        controller.abort();
        return { content: '已请求中止', isError: false };
      },
    };
    const harness = await makeAgent(
      [
        [toolCall('c1', 'abort-now', {}), done('tool_calls')],
        [text('不该到达'), done()],
      ],
      { extraTools: [abortTool] },
    );
    try {
      const result = await harness.agent.run('任务', { signal: controller.signal });
      assert.equal(result.turns, 1);
      assert.equal(harness.adapter.calls, 1);
    } finally {
      await harness.cleanup();
    }
  });

  it('中断时未执行的工具调用也补上结果,不留悬空 tool call', async () => {
    const controller = new AbortController();
    const abortTool: Tool = {
      name: 'abort-now',
      description: '触发中止',
      parameters: { type: 'object' },
      permissionKind: 'bash',
      targetOf: () => ({}),
      execute: async () => {
        controller.abort();
        return { content: '已请求中止', isError: false };
      },
    };
    const harness = await makeAgent(
      [[toolCall('c1', 'abort-now', {}), toolCall('c2', 'abort-now', {}), done('tool_calls')]],
      { extraTools: [abortTool] },
    );
    try {
      await harness.agent.run('任务', { signal: controller.signal });
      const branch = harness.session.activeBranch();
      const callIds = branch.flatMap((entry) =>
        entry.type === 'assistant' ? entry.toolCalls.map((call) => call.id) : [],
      );
      const resultIds = branch.flatMap((entry) =>
        entry.type === 'tool_result' ? [entry.toolCallId] : [],
      );
      // 每个 tool call 都必须有配对结果,否则下一次请求会被端点以「tool_calls 必须跟 tool 消息」拒绝
      assert.deepEqual(callIds, ['c1', 'c2']);
      assert.deepEqual(resultIds, ['c1', 'c2']);
    } finally {
      await harness.cleanup();
    }
  });

  it('compact() 可强制压缩;内容过少或未配置压缩器时返回 false', async () => {
    const harness = await makeAgent([[text('a'), done()]], {
      compactor: async () => '摘要内容',
    });
    try {
      assert.equal(await harness.agent.compact(), false);
      await harness.session.append({ type: 'user', text: 'x1' });
      await harness.session.append({ type: 'assistant', text: 'a1', toolCalls: [] });
      await harness.session.append({ type: 'user', text: 'x2' });
      assert.equal(await harness.agent.compact(), true);
      assert.ok(harness.session.activeBranch().some((entry) => entry.type === 'summary'));
      assert.equal(await harness.agent.compact(), false);
    } finally {
      await harness.cleanup();
    }

    const bare = await makeAgent([[text('a'), done()]]);
    try {
      await bare.session.append({ type: 'user', text: 'x1' });
      await bare.session.append({ type: 'assistant', text: 'a1', toolCalls: [] });
      await bare.session.append({ type: 'user', text: 'x2' });
      assert.equal(await bare.agent.compact(), false);
    } finally {
      await bare.cleanup();
    }
  });
});
