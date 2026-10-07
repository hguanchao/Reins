import {
  truncateAnsi,
  truncatePlain,
  visibleWidth,
  wrapPlain,
} from './layout.ts';
import { renderMarkdown } from './markdown.ts';
import { symbols, type Theme } from './theme.ts';

/**
 * 滚动区块模型:对话历史的唯一数据结构。
 *
 * 设计意图:每个区块自带渲染结果(纯函数),状态由上层事件驱动;
 * 渲染只依赖区块自身与宽度/主题,便于测试;工具输出默认折叠成一行,
 * 展开后给出预览,完整内容交给全屏查看器。
 */

export type ToolState = 'running' | 'ok' | 'fail';
export type NoticeLevel = 'info' | 'warn' | 'error';

export type ScrollBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | {
      kind: 'tool';
      name: string;
      summary: string;
      state: ToolState;
      elapsedMs?: number;
      detail?: string;
      /** 完整工具输出;折叠时不渲染,展开/查看器使用。 */
      output?: string;
      /** 是否展开预览输出。 */
      expanded?: boolean;
    }
  | { kind: 'notice'; text: string; level: NoticeLevel }
  | { kind: 'welcome' };

export interface RenderContext {
  spinner: string;
  theme: Theme;
}

/** 展开时最多预览的输出行数;再多交给全屏查看器。 */
const PREVIEW_LINES = 10;

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
      return renderUser(block.text, width, context.theme);
    case 'assistant':
      return renderAssistant(block, width, context.theme);
    case 'tool':
      return renderTool(block, width, context);
    case 'notice':
      return renderNotice(block, width, context.theme);
    case 'welcome':
      return renderWelcome(width, context.theme);
  }
}

/** 全屏查看器用的完整渲染:工具块输出全部展开,其余与普通渲染一致。 */
export function renderBlockVerbose(block: ScrollBlock, width: number, context: RenderContext): string[] {
  if (block.kind !== 'tool') {
    return renderBlock(block, width, context);
  }
  const theme = context.theme;
  const lines = [renderToolHead(block, width, context)];
  const body = toolOutputLines(block, width - 4, theme);
  if (body.length === 0) {
    lines.push(`    ${theme.paint.muted('(无输出)')}`);
  }
  lines.push(...body);
  return lines;
}

function renderUser(text: string, width: number, theme: Theme): string[] {
  const label = '你 ';
  const ruleWidth = Math.max(0, width - visibleWidth(label) - 1);
  const lines = [`${theme.paint.accent(label)}${theme.paint.muted(symbols.separator.repeat(ruleWidth))}`];
  for (const line of wrapPlain(text, Math.max(1, width - 2))) {
    lines.push(line === '' ? '' : `  ${line}`);
  }
  return lines;
}

function renderAssistant(
  block: { text: string; streaming: boolean },
  width: number,
  theme: Theme,
): string[] {
  const lines: string[] = [theme.bold('助手')];
  const body = renderMarkdown(block.text, width, theme);
  if (block.streaming) {
    if (body.length === 0) {
      body.push(theme.paint.muted(symbols.cursor));
    } else {
      const last = body.length - 1;
      body[last] = `${body[last]}${theme.paint.muted(symbols.cursor)}`;
    }
  }
  lines.push(...body);
  return lines;
}

function renderTool(
  block: { name: string; summary: string; state: ToolState; elapsedMs?: number; detail?: string; output?: string; expanded?: boolean },
  width: number,
  context: RenderContext,
): string[] {
  const theme = context.theme;
  const lines = [renderToolHead(block, width, context)];
  const output = toolOutputLines(block, width - 4, theme);
  if (block.expanded === true && output.length > 0) {
    const preview = output.slice(0, PREVIEW_LINES);
    lines.push(...preview);
    if (output.length > PREVIEW_LINES) {
      lines.push(`    ${theme.paint.muted(`… 共 ${output.length} 行 · Ctrl+O 全屏查看`)}`);
    }
  } else if (block.detail !== undefined && block.detail !== '') {
    const detail = truncatePlain(block.detail, Math.max(0, width - 8));
    lines.push(`    ${block.state === 'fail' ? theme.paint.fail(`↳ ${detail}`) : theme.paint.muted(`↳ ${detail}`)}`);
  }
  return lines;
}

function renderToolHead(
  block: { name: string; summary: string; state: ToolState; elapsedMs?: number; output?: string },
  width: number,
  context: RenderContext,
): string {
  const theme = context.theme;
  const statusPlain =
    block.state === 'running'
      ? `${context.spinner} 运行中…`
      : `${block.state === 'ok' ? symbols.ok : symbols.fail}${
          block.elapsedMs !== undefined ? ` ${formatElapsed(block.elapsedMs)}` : ''
        }`;
  const status =
    block.state === 'running'
      ? theme.paint.warn(statusPlain)
      : block.state === 'ok'
        ? theme.paint.ok(statusPlain)
        : theme.paint.fail(statusPlain);

  let summaryText = block.summary;
  if (summaryText !== '') {
    const allow = width - visibleWidth(`  ${symbols.tool} ${block.name}`) - 2 - visibleWidth(statusPlain) - 2;
    summaryText = allow > 4 ? truncatePlain(summaryText, allow) : '';
  }
  const line = `${theme.paint.muted(`  ${symbols.tool}`)} ${theme.bold(block.name)}${
    summaryText === '' ? '' : `  ${theme.paint.muted(summaryText)}`
  }  ${status}`;
  const head = `  ${symbols.tool} ${block.name}`;
  return visibleWidth(head) + 2 + visibleWidth(statusPlain) > width ? truncateAnsi(line, width) : line;
}

/** 工具输出的显示行:原样换行,不附加样式(内容本身可读性优先)。 */
function toolOutputLines(
  block: { output?: string },
  width: number,
  _theme: Theme,
): string[] {
  if (block.output === undefined || block.output === '') {
    return [];
  }
  const lines: string[] = [];
  for (const raw of block.output.split('\n')) {
    const wrapped = wrapPlain(raw, Math.max(8, width));
    for (const line of wrapped) {
      lines.push(line === '' ? '' : `    ${line}`);
    }
  }
  return lines;
}

function renderNotice(
  block: { text: string; level: NoticeLevel },
  width: number,
  theme: Theme,
): string[] {
  const prefix = block.level === 'info' ? '·' : block.level === 'warn' ? symbols.warn : symbols.fail;
  const color = block.level === 'info' ? theme.paint.muted : block.level === 'warn' ? theme.paint.warn : theme.paint.fail;
  const body = wrapPlain(block.text, Math.max(1, width - 4));
  return body.map((line, index) => `  ${color(index === 0 ? `${prefix} ${line}` : `  ${line}`)}`);
}

function renderWelcome(width: number, theme: Theme): string[] {
  const boxWidth = Math.min(66, width - 4);
  if (boxWidth < 20) {
    return [`  ${truncatePlain('欢迎使用 Reins', Math.max(0, width - 2))}`];
  }
  const inner = boxWidth - 4;
  const entries: { text: string; style?: (text: string) => string }[] = [
    { text: '欢迎使用 Reins', style: theme.paint.accent },
    { text: '' },
    { text: '直接输入任务开始,或:' },
    { text: '  /    查看命令        @    引用文件' },
    { text: '' },
    { text: 'Ctrl+O 查看工具输出 · Ctrl+E 展开折叠 · 滚轮翻历史', style: theme.paint.muted },
    { text: '提示:reins doctor 可自检配置', style: theme.paint.muted },
  ];
  const lines: string[] = [`  ${theme.paint.muted(`╭${'─'.repeat(boxWidth - 2)}╮`)}`];
  for (const entry of entries) {
    const text = entry.text === '' ? '' : fitStyled(entry.text, inner, entry.style);
    lines.push(`  ${theme.paint.muted('│')} ${text} ${theme.paint.muted('│')}`);
  }
  lines.push(`  ${theme.paint.muted(`╰${'─'.repeat(boxWidth - 2)}╯`)}`);
  return lines;
}

/** 在固定宽度内渲染并补齐空格(样式包裹后按可见宽度补齐)。 */
function fitStyled(text: string, width: number, style: ((text: string) => string) | undefined): string {
  const cut = truncatePlain(text, width);
  const pad = width - visibleWidth(cut);
  const padded = pad > 0 ? cut + ' '.repeat(pad) : cut;
  return style !== undefined ? style(padded) : padded;
}

/** 带缓存的区块渲染器:同区块同参数直接复用上一帧的行。 */
export interface BlockRenderer {
  render(block: ScrollBlock, width: number): string[];
}

export function createBlockRenderer(context: RenderContext): BlockRenderer {
  const cache = new WeakMap<ScrollBlock, { stamp: string; lines: string[] }>();
  return {
    render(block: ScrollBlock, width: number): string[] {
      const stamp = cacheStamp(block, width, context);
      const hit = cache.get(block);
      if (hit !== undefined && hit.stamp === stamp) {
        return hit.lines;
      }
      const lines = renderBlock(block, width, context);
      cache.set(block, { stamp, lines });
      return lines;
    },
  };
}

/** 缓存键:覆盖所有会影响渲染结果的输入。 */
function cacheStamp(block: ScrollBlock, width: number, context: RenderContext): string {
  const base = `${width}|${context.theme.name}|${context.theme.useColor}`;
  switch (block.kind) {
    case 'user':
      return `${base}|u|${block.text}`;
    case 'assistant':
      return `${base}|a|${block.streaming}|${block.text.length}|${block.text.slice(-80)}`;
    case 'tool':
      return `${base}|t|${block.state}|${block.elapsedMs ?? ''}|${block.expanded === true}|${
        block.output?.length ?? 0
      }|${block.detail ?? ''}|${block.state === 'running' ? context.spinner : ''}`;
    case 'notice':
      return `${base}|n|${block.level}|${block.text}`;
    case 'welcome':
      return `${base}|w|`;
  }
}
