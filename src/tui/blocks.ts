import {
  paintRow,
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

/** 助手正文的左缩进:与用户消息正文、工具块共用同一条左边界。 */
const ASSISTANT_INDENT = 2;

/** 用户消息条:整行中性灰,前缀 › 取强调色,上下各留一行空白条带,不标注角色。 */
function renderUser(text: string, width: number, theme: Theme): string[] {
  const prefix = '› ';
  const prefixWidth = visibleWidth(prefix);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const raw = text === '' ? [''] : wrapPlain(text, bodyWidth);
  const body = raw.map((line, index) => {
    const head = index === 0 ? theme.paint.accent(prefix) : ' '.repeat(prefixWidth);
    return paintRow(`${head}${line}`, width, theme.codes.userBar);
  });
  // 上下各补一行空白条带:消息条有厚度,不贴着文字
  const blank = paintRow('', width, theme.codes.userBar);
  return [blank, ...body, blank];
}

function renderAssistant(
  block: { text: string; streaming: boolean },
  width: number,
  theme: Theme,
): string[] {
  // 正文左缩进与用户消息正文对齐,不标注角色
  const body = renderMarkdown(block.text, width, theme, ASSISTANT_INDENT);
  if (block.streaming) {
    if (body.length === 0) {
      body.push(`${' '.repeat(ASSISTANT_INDENT)}${theme.paint.muted(symbols.cursor)}`);
    } else {
      const last = body.length - 1;
      body[last] = `${body[last]}${theme.paint.muted(symbols.cursor)}`;
    }
  }
  return body;
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

/** 欢迎面板只展示核心命令(完整清单见 /help)。 */
const WELCOME_COMMANDS: readonly { command: string; description: string }[] = [
  { command: '/help', description: '显示帮助' },
  { command: '/new', description: '开始新会话' },
  { command: '/model', description: '查看或切换模型' },
  { command: '/resume', description: '恢复会话' },
  { command: '/exit', description: '退出' },
];

/** 欢迎面板只展示核心快捷键(完整行为见提示行)。 */
const WELCOME_SHORTCUTS: readonly { keys: string; description: string }[] = [
  { keys: '@', description: '引用文件或目录' },
  { keys: '↑/↓', description: '移动光标 · 顶底翻历史' },
  { keys: 'Tab', description: '应用补全' },
  { keys: 'Ctrl+J', description: '插入换行' },
  { keys: 'Ctrl+O', description: '全屏查看输出' },
  { keys: 'Ctrl+C/Esc', description: '中断运行' },
];

/** 按显示宽度右补空格(命令与按键列都是窄字符,统一按可见宽计算)。 */
function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

const WELCOME_TITLE = '欢迎使用 Reins';
const WELCOME_HINT = '提示:reins doctor 可自检配置';

/** 欢迎面板的一行:text 为纯文本,style 只作用于需要上色的区段。 */
interface WelcomeRow {
  text: string;
  style?: (plain: string) => string;
  center?: boolean;
}

/** 一节里按键列的宽度:该节最长按键 + 两格间隔。 */
function keyColumnWidth(keys: readonly string[]): number {
  return keys.reduce((max, key) => Math.max(max, visibleWidth(key)), 0) + 2;
}

function renderWelcome(width: number, theme: Theme): string[] {
  if (width < 30) {
    const text = truncatePlain(WELCOME_TITLE, Math.max(0, width - 2));
    const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
    return [' '.repeat(pad) + text];
  }

  // 命令与快捷键共用一条说明列:两节的说明文本逐行对齐,纵向扫读更整齐
  const keyColumn = keyColumnWidth([
    ...WELCOME_COMMANDS.map((entry) => entry.command),
    ...WELCOME_SHORTCUTS.map((entry) => entry.keys),
  ]);

  // 盒宽贴合内容:内容只有三十来格,固定宽度会在右侧留一大片空白
  const natural = Math.max(
    visibleWidth(WELCOME_TITLE),
    visibleWidth(WELCOME_HINT),
    ...WELCOME_COMMANDS.map((entry) => 2 + keyColumn + visibleWidth(entry.description)),
    ...WELCOME_SHORTCUTS.map((entry) => 2 + keyColumn + visibleWidth(entry.description)),
  );
  const boxWidth = Math.min(natural + 6, width - 4);
  const inner = boxWidth - 6;

  const entryRow = (key: string, description: string): WelcomeRow => ({
    text: `  ${padDisplay(key, keyColumn)}${description}`,
    // 只给按键列取强调色:一眼先看到能敲什么;说明保持常规色,整块才不会发灰
    style: (plain) => `${theme.paint.accent(plain.slice(0, keyColumn + 2))}${plain.slice(keyColumn + 2)}`,
  });

  const rows: WelcomeRow[] = [];
  rows.push({ text: WELCOME_TITLE, style: theme.paint.accent, center: true });
  rows.push({ text: '' });
  rows.push({ text: '斜杠命令', style: theme.bold });
  for (const entry of WELCOME_COMMANDS) {
    rows.push(entryRow(entry.command, entry.description));
  }
  rows.push({ text: '' });
  rows.push({ text: '快捷键', style: theme.bold });
  for (const entry of WELCOME_SHORTCUTS) {
    rows.push(entryRow(entry.keys, entry.description));
  }
  rows.push({ text: '' });
  rows.push({ text: WELCOME_HINT, style: theme.paint.muted });

  // 内容统一裁到 inner 再补齐,保证每一行(含边框行)显示宽度严格等于盒宽
  const buildContent = (row: WelcomeRow): string => {
    if (row.text === '') {
      return ' '.repeat(inner);
    }
    const plain = truncatePlain(row.text, inner);
    if (row.center === true) {
      const left = Math.max(0, Math.floor((inner - visibleWidth(plain)) / 2));
      return padDisplay(' '.repeat(left) + (row.style !== undefined ? row.style(plain) : plain), inner);
    }
    return padDisplay(row.style !== undefined ? row.style(plain) : plain, inner);
  };

  const frame = theme.paint.muted;
  const indent = ' '.repeat(Math.max(0, Math.floor((width - boxWidth) / 2)));
  const lines: string[] = [`${indent}${frame(`┌${'─'.repeat(boxWidth - 2)}┐`)}`];
  for (const row of rows) {
    lines.push(`${indent}${frame('│')}  ${buildContent(row)}  ${frame('│')}`);
  }
  lines.push(`${indent}${frame(`└${'─'.repeat(boxWidth - 2)}┘`)}`);
  return lines;
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
