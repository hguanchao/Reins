import type { ToolCall, Usage } from '../llm/types.ts';
import { sanitizeTerminalText } from '../util/ansi.ts';

/**
 * 界面呈现契约与最简实现。
 *
 * 设计意图:代理循环只依赖这里的事件接口;
 * 控制台实现负责简单渲染,静默实现供测试与非交互场景使用。
 */

export interface AgentUi {
  onAssistantText(text: string): void;
  onToolCall(call: ToolCall): void;
  onToolResult(name: string, content: string, isError: boolean): void;
  onNotice(message: string): void;
  /** 用量事件:每轮模型调用结束后上报,供界面展示上下文占用。 */
  onUsage?(usage: Usage): void;
}

/** 控制台渲染:文本原样流出,工具事件折叠成单行摘要。 */
export class ConsoleUi implements AgentUi {
  readonly out: (text: string) => void;

  constructor(out: (text: string) => void = (text) => process.stdout.write(text)) {
    this.out = out;
  }

  onAssistantText(text: string): void {
    // 模型输出不可信:剥掉转义序列,避免污染终端(标题、清屏、剪贴板)
    this.out(sanitizeTerminalText(text));
  }

  onToolCall(call: ToolCall): void {
    this.out(`\n[工具] ${call.name} ${sanitizeTerminalText(call.arguments)}\n`);
  }

  onToolResult(name: string, content: string, isError: boolean): void {
    const clean = sanitizeTerminalText(content);
    const firstLine = clean.split('\n')[0] ?? '';
    const suffix = clean.includes('\n') ? ' …' : '';
    this.out(`[${isError ? '失败' : '完成'}] ${name}: ${firstLine}${suffix}\n`);
  }

  onNotice(message: string): void {
    this.out(`[提示] ${sanitizeTerminalText(message)}\n`);
  }
}

/** 静默实现:无任何输出。 */
export class SilentUi implements AgentUi {
  onAssistantText(_text: string): void {}
  onToolCall(_call: ToolCall): void {}
  onToolResult(_name: string, _content: string, _isError: boolean): void {}
  onNotice(_message: string): void {}
}
