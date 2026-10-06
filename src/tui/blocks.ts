import { fitPlain, truncateAnsi, truncatePlain, visibleWidth, wrapPlain } from './layout.ts';
import { paint, symbols } from './theme.ts';

/**
 * 滚动区块模型:对话历史的唯一数据结构。
 *
 * 设计意图:每个区块自带渲染结果(纯函数),状态由上层事件驱动;
 * 渲染只依赖区块自身与宽度,便于测试与差分渲染。
 */

export type ToolState = 'running' | 'ok' | 'fail';
export type NoticeLevel = 'info' | 'warn' | 'error';

export type ScrollBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; name: string; summary: string; state: ToolState; elapsedMs?: number; detail?: string }
  | { kind: 'notice'; text: string; level: NoticeLevel }
  | { kind: 'welcome' };

export interface RenderContext {
  spinner: string;
}

/** 把工具参数 JSON 压成一行摘要:优先常见键,否则取第一个字符串值。 */
export function summarizeToolArgs(argumentsJson: string): string {
  const compact = (text: string): string => text.replace(/\s+/g, ' ').trim();
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return compact(argumentsJson);
    }
    const record = parsed as Record<string, unknown>;
    for (const key of ['command', 'path', 'pattern', 'url', 'query', 'server', 'name']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return compact(value);
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim() !== '') {
        return compact(value);
      }
    }
    return compact(argumentsJson);
  } catch {
    return compact(argumentsJson);
  }
}

/** 耗时格式化:0.1s 精度。 */
export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 渲染单个区块为若干显示行(含 ANSI 样式)。 */
export function renderBlock(block: ScrollBlock, width: number, context: RenderContext): string[] {
  switch (block.kind) {
    case 'user':
      return renderUser(block.text, width);
    case 'assistant':
      return renderAssistant(block, width);
    case 'tool':
      return renderTool(block, width, context);
    case 'notice':
      return renderNotice(block, width);
    case 'welcome':
      return renderWelcome(width);
  }
}

function renderUser(text: string, width: number): string[] {
  const label = '你 ';
  const ruleWidth = Math.max(0, width - visibleWidth(label) - 1);
  const lines = [`${paint.cyanBold(label)}${paint.gray(symbols.separator.repeat(ruleWidth))}`];
  for (const line of wrapPlain(text, Math.max(1, width - 2))) {
    lines.push(line === '' ? '' : `  ${line}`);
  }
  return lines;
}

function renderAssistant(block: { text: string; streaming: boolean }, width: number): string[] {
  const lines: string[] = [paint.bold('助手')];
  const body = wrapPlain(block.text, Math.max(1, width - 2));
  if (block.streaming) {
    const last = body.length - 1;
    const current = body[last] ?? '';
    body[last] = `${current}${paint.gray(symbols.cursor)}`;
  }
  for (const line of body) {
    lines.push(line === '' ? '' : `  ${line}`);
  }
  return lines;
}

function renderTool(
  block: { name: string; summary: string; state: ToolState; elapsedMs?: number; detail?: string },
  width: number,
  context: RenderContext,
): string[] {
  const head = `  ${symbols.tool} ${block.name}`;
  const statusPlain =
    block.state === 'running'
      ? `${context.spinner} 运行中…`
      : `${block.state === 'ok' ? symbols.ok : symbols.fail}${
          block.elapsedMs !== undefined ? ` ${formatElapsed(block.elapsedMs)}` : ''
        }`;
  const status =
    block.state === 'running'
      ? paint.amber(statusPlain)
      : block.state === 'ok'
        ? paint.green(statusPlain)
        : paint.red(statusPlain);

  let summaryText = block.summary;
  if (summaryText !== '') {
    const allow = width - visibleWidth(head) - 2 - visibleWidth(statusPlain) - 2;
    summaryText = allow > 4 ? truncatePlain(summaryText, allow) : '';
  }
  const line = `${paint.gray(`  ${symbols.tool}`)} ${paint.bold(block.name)}${
    summaryText === '' ? '' : `  ${paint.gray(summaryText)}`
  }  ${status}`;
  const lines = [
    visibleWidth(head) + 2 + visibleWidth(statusPlain) > width ? truncateAnsi(line, width) : line,
  ];
  if (block.detail !== undefined && block.detail !== '') {
    const detail = truncatePlain(block.detail, Math.max(0, width - 8));
    lines.push(`    ${block.state === 'fail' ? paint.red(`↳ ${detail}`) : paint.gray(`↳ ${detail}`)}`);
  }
  return lines;
}

function renderNotice(block: { text: string; level: NoticeLevel }, width: number): string[] {
  const prefix = block.level === 'info' ? '·' : block.level === 'warn' ? symbols.warn : symbols.fail;
  const color = block.level === 'info' ? paint.gray : block.level === 'warn' ? paint.amber : paint.red;
  const body = wrapPlain(block.text, Math.max(1, width - 4));
  return body.map((line, index) => `  ${color(index === 0 ? `${prefix} ${line}` : `  ${line}`)}`);
}

function renderWelcome(width: number): string[] {
  const boxWidth = Math.min(66, width - 4);
  if (boxWidth < 20) {
    return [`  ${truncatePlain('欢迎使用 Reins', Math.max(0, width - 2))}`];
  }
  const inner = boxWidth - 4;
  const entries: { text: string; style?: (text: string) => string }[] = [
    { text: '欢迎使用 Reins', style: paint.cyanBold },
    { text: '' },
    { text: '直接输入任务开始,或:' },
    { text: '  /    查看命令        @    引用文件(M2)' },
    { text: '' },
    { text: '提示:reins doctor 可自检配置', style: paint.gray },
  ];
  const lines: string[] = [`  ${paint.gray(`╭${'─'.repeat(boxWidth - 2)}╮`)}`];
  for (const entry of entries) {
    const text = fitPlain(entry.text, inner);
    lines.push(`  ${paint.gray('│')} ${entry.style ? entry.style(text) : text} ${paint.gray('│')}`);
  }
  lines.push(`  ${paint.gray(`╰${'─'.repeat(boxWidth - 2)}╯`)}`);
  return lines;
}
