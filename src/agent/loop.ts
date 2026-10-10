import type { Config } from '../config/schema.ts';
import type {
  AdapterRuntime,
  ChatMessage,
  ProviderAdapter,
  ResolvedModel,
  ToolCall,
  Usage,
} from '../llm/types.ts';
import { addUsage } from '../llm/usage.ts';
import type { ApprovalGate } from '../permissions/approval.ts';
import type { Decision, PermissionEngine } from '../permissions/engine.ts';
import type { RuleTarget } from '../permissions/rules.ts';
import type { Sandbox } from '../permissions/sandbox.ts';
import { formatTranscript, shouldCompact } from '../session/compaction.ts';
import type { Session } from '../session/tree.ts';
import { buildPreview, buildSpillNotice, shouldSpill } from '../spill/policy.ts';
import type { SpillStore } from '../spill/store.ts';
import { resolveRealPath } from '../tools/realpath.ts';
import type { Tool, ToolRegistry } from '../tools/registry.ts';
import type { AgentUi } from '../ui/printer.ts';
import { describeError } from '../util/errors.ts';
import { collectModelTurn } from './turn.ts';

/**
 * 代理循环。
 *
 * 设计意图:循环本身只做四件事——组装请求、收集单轮结果、执行工具、落盘;
 * 所有依赖显式注入,循环不创建任何资源,便于测试与替换。
 */

export interface AgentOptions {
  config: Config;
  adapter: ProviderAdapter;
  model: ResolvedModel;
  registry: ToolRegistry;
  session: Session;
  engine: PermissionEngine;
  sandbox: Sandbox;
  approval: ApprovalGate;
  spill: SpillStore;
  ui: AgentUi;
  workspace: string;
  systemPrompt: string;
  runtime: AdapterRuntime;
  /** 上下文压缩器;未注入时不做压缩。 */
  compactor?: (transcript: string) => Promise<string>;
}

export interface AgentRunResult {
  text: string;
  turns: number;
  usage: Usage;
}

/** 单次运行的选项。 */
export interface AgentRunOptions {
  /** 外部中止信号:触发后尽快停止本次运行。 */
  signal?: AbortSignal;
}

export class Agent {
  private readonly options: AgentOptions;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  /** 执行一次用户输入,直到模型不再请求工具;返回最终文本与统计。 */
  async run(userText: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const { session, config, ui } = this.options;
    const signal = options.signal;
    await session.append({ type: 'user', text: userText });

    let turns = 0;
    let finalText = '';
    let total: Usage = { inputTokens: 0, outputTokens: 0 };
    let aborted = false;

    for (;;) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (config.maxTurns !== undefined && turns >= config.maxTurns) {
        ui.onNotice(`达到模型轮数上限(${config.maxTurns}),停止`);
        break;
      }
      turns += 1;
      const turn = await this.runModelTurn(signal).catch((error: unknown) => {
        if (signal?.aborted) {
          return undefined;
        }
        throw error;
      });
      if (turn === undefined) {
        aborted = true;
        break;
      }
      total = addUsage(total, turn.usage);
      if (turn.text !== '') {
        finalText = turn.text;
      }
      if (turn.toolCalls.length === 0) {
        break;
      }
      let executed = 0;
      for (const call of turn.toolCalls) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        await this.executeToolCall(call, signal);
        executed += 1;
      }
      if (aborted) {
        // 中断时补齐未执行调用的结果:assistant 消息已带着全部 tool call 落盘,
        // 缺配对结果会让下一次请求被端点以「tool_calls 必须跟 tool 消息」拒绝,会话再也无法继续
        for (const call of turn.toolCalls.slice(executed)) {
          await this.recordToolResult(call, '已中断:未执行', true);
        }
        break;
      }
      await this.maybeCompact(turn.usage.inputTokens);
    }

    if (aborted) {
      await session.append({ type: 'assistant', text: '(已中断)', toolCalls: [] });
      ui.onNotice('运行已中断');
    }

    return { text: finalText, turns, usage: total };
  }

  private async runModelTurn(signal?: AbortSignal) {
    const { adapter, runtime, model, config, registry, session, ui, systemPrompt } = this.options;
    const turn = await collectModelTurn({
      adapter,
      runtime,
      request: {
        model,
        messages: this.buildMessages(systemPrompt),
        tools: registry.toToolSpecs(),
        maxTokens: config.maxTokens,
        reasoningEffort: config.reasoningEffort,
        signal,
      },
      onText: (text) => ui.onAssistantText(text),
      onToolCall: (call) => ui.onToolCall(call),
    });
    ui.onUsage?.(turn.usage);
    await session.append({
      type: 'assistant',
      text: turn.text,
      toolCalls: turn.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    });
    return turn;
  }

  /** 把活动分支转换为模型消息;存在摘要时,只保留摘要及其之后的条目。 */
  private buildMessages(systemPrompt: string): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    const branch = this.options.session.activeBranch();
    let start = 0;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      if (branch[index]?.type === 'summary') {
        start = index;
        break;
      }
    }
    for (const entry of branch.slice(start)) {
      if (entry.type === 'user') {
        messages.push({ role: 'user', content: entry.text });
      } else if (entry.type === 'assistant') {
        messages.push({ role: 'assistant', content: entry.text, toolCalls: entry.toolCalls });
      } else if (entry.type === 'tool_result') {
        messages.push({
          role: 'tool',
          content: entry.content,
          toolCallId: entry.toolCallId,
          name: entry.name,
        });
      } else if (entry.type === 'summary') {
        messages.push({ role: 'user', content: `(context summary)\n${entry.text}` });
      }
    }
    return messages;
  }

  /** 执行一次工具调用:参数解析 → 策略/沙箱 → 审批 → 执行 → 落盘。 */
  private async executeToolCall(call: ToolCall, signal?: AbortSignal): Promise<void> {
    const { registry, engine, approval, spill, config, workspace, ui } = this.options;

    const tool = registry.get(call.name);
    if (tool === undefined) {
      await this.recordToolResult(call, `未知工具:${call.name}`, true);
      return;
    }

    const input = await this.parseArguments(call);
    if (input === undefined) {
      return;
    }

    let target: RuleTarget;
    try {
      target = { tool: tool.ruleToolName ?? call.name, ...tool.targetOf(input, { workspace }) };
    } catch (error) {
      await this.recordToolResult(call, `工具参数不完整:${describeError(error)}`, true);
      return;
    }

    let decision = (await this.checkSandbox(tool, target)) ?? engine.evaluate(target, tool.permissionKind);
    if (decision.verdict === 'ask') {
      // 审批批的是「这次改动」,把工具给出的预览一并交给界面
      decision = await approval.decide(target, decision, tool.previewOf?.(input, { workspace }));
    }
    if (decision.verdict !== 'allow') {
      ui.onNotice(`${call.name} 被拒绝:${decision.reason}`);
      await this.recordToolResult(call, `操作被拒绝:${decision.reason}`, true);
      return;
    }

    let content: string;
    let isError: boolean;
    try {
      const outcome = await tool.execute(input, { workspace, signal });
      content = outcome.content;
      isError = outcome.isError;
    } catch (error) {
      content = `工具执行失败:${describeError(error)}`;
      isError = true;
    }

    if (shouldSpill(content, config.spillThreshold)) {
      const saved = await spill.save(content, call.name);
      content = buildSpillNotice(saved.path, content.length, buildPreview(content));
    }
    await this.recordToolResult(call, content, isError);
  }

  private async parseArguments(call: ToolCall): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed = JSON.parse(call.arguments === '' ? '{}' : call.arguments) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('参数应为 JSON 对象');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      await this.recordToolResult(call, `工具参数解析失败:${describeError(error)}`, true);
      return undefined;
    }
  }

  private async checkSandbox(tool: Tool, target: RuleTarget): Promise<Decision | null> {
    if (target.path === undefined) {
      return null;
    }
    const action =
      tool.permissionKind === 'path-write' ? 'write' : tool.permissionKind === 'path-read' ? 'read' : undefined;
    if (action === undefined) {
      return null;
    }
    // 判定前先解析真实路径:工作区内的符号链接可以把写操作引到工作区之外,
    // 只按字面路径判定等于边界形同虚设
    return this.options.sandbox.checkPath(action, await resolveRealPath(target.path));
  }

  /** 立即压缩上下文(手动触发);内容过少或压缩器不可用时返回 false。 */
  async compact(): Promise<boolean> {
    return await this.compactNow(true, 0);
  }

  /** 上下文接近窗口上限时触发压缩;失败不阻断主流程。 */
  private async maybeCompact(usedTokens: number): Promise<void> {
    await this.compactNow(false, usedTokens);
  }

  private async compactNow(force: boolean, usedTokens: number): Promise<boolean> {
    const compactor = this.options.compactor;
    if (compactor === undefined) {
      return false;
    }
    if (!force && !shouldCompact(usedTokens, this.options.model.contextWindow)) {
      return false;
    }
    const branch = this.options.session.activeBranch();
    let lastSummary = -1;
    for (let index = 0; index < branch.length; index += 1) {
      if (branch[index]?.type === 'summary') {
        lastSummary = index;
      }
    }
    const compressible = branch.length - (lastSummary + 1);
    if (compressible < 3) {
      return false;
    }
    try {
      const summary = (await compactor(formatTranscript(branch))).trim();
      if (summary === '') {
        return false;
      }
      await this.options.session.append({ type: 'summary', text: summary });
      this.options.ui.onNotice('上下文已压缩为摘要');
      return true;
    } catch (error) {
      this.options.ui.onNotice(`上下文压缩失败,继续运行:${describeError(error)}`);
      return false;
    }
  }

  private async recordToolResult(call: ToolCall, content: string, isError: boolean): Promise<void> {
    await this.options.session.append({
      type: 'tool_result',
      toolCallId: call.id,
      name: call.name,
      content,
      isError,
    });
    this.options.ui.onToolResult(call.name, content, isError);
  }
}
