/**
 * 聊天命令:斜杠命令解析与补全(纯文本与 TUI 两种模式共用)。
 *
 * 设计意图:全部保持纯函数,便于单测;UI 层只负责呈现与执行。
 */

export type ChatCommand =
  | { type: 'exit' }
  | { type: 'help' }
  | { type: 'new' }
  | { type: 'compact' }
  | { type: 'mcp' }
  | { type: 'model'; target: string | undefined }
  | { type: 'effort'; value: string | undefined }
  | { type: 'resume'; id: string | undefined }
  | { type: 'empty' }
  | { type: 'prompt'; text: string };

/** 可补全的斜杠命令集合。 */
export const CHAT_COMMANDS: readonly string[] = [
  '/compact',
  '/effort',
  '/help',
  '/mcp',
  '/model',
  '/new',
  '/quit',
  '/sessions',
];

/**
 * 斜杠命令的说明,供补全菜单逐条展示。
 *
 * 别名(/mcps)与主命令共用同一句说明,菜单里不区分。
 */
export const CHAT_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/compact': '立即压缩上下文',
  '/effort': '查看或切换思考强度',
  '/help': '显示帮助',
  '/mcp': '显示 MCP 服务器状态',
  '/model': '查看或切换模型',
  '/new': '开始新会话',
  '/quit': '退出',
  '/sessions': '恢复会话;无 id 时列出',
};

/** 解析一行输入:斜杠命令或普通任务文本(未知斜杠按普通文本处理)。 */
export function parseChatCommand(input: string): ChatCommand {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { type: 'empty' };
  }
  if (!trimmed.startsWith('/')) {
    return { type: 'prompt', text: trimmed };
  }
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim() === '' ? undefined : rest.join(' ').trim();
  switch ((name ?? '').toLowerCase()) {
    case 'quit':
      return { type: 'exit' };
    case 'help':
    case 'hotkeys':
      return { type: 'help' };
    case 'new':
      return { type: 'new' };
    case 'compact':
      return { type: 'compact' };
    case 'mcp':
    case 'mcps':
      return { type: 'mcp' };
    case 'model':
    case 'm':
      return { type: 'model', target: arg };
    case 'effort':
      return { type: 'effort', value: arg };
    case 'sessions':
      return { type: 'resume', id: arg };
    default:
      return { type: 'prompt', text: trimmed };
  }
}

/** 补全斜杠命令;非斜杠输入不补全。 */
export function completeChatInput(line: string): [string[], string] {
  if (!line.startsWith('/') || line.includes(' ')) {
    return [[], line];
  }
  const matches = CHAT_COMMANDS.filter((command) => command.startsWith(line));
  return [matches, line];
}

/** 中断决策:运行中优先中断,空闲时先清空输入,空行再退出。 */
export function decideInterrupt(state: { running: boolean; hasInput: boolean }): 'abort' | 'clear' | 'exit' {
  if (state.running) {
    return 'abort';
  }
  if (state.hasInput) {
    return 'clear';
  }
  return 'exit';
}

/**
 * 快捷键速查:`?` 页与 /help 共用这一份,免得两处各写一份键位表、日后走样。
 *
 * keys 只用单宽字符,这样 /help 的纯文本列能用 padEnd 对齐。
 */
export const CHAT_KEY_HELP: readonly { keys: string; action: string }[] = [
  { keys: '↑ / ↓', action: '输入历史;候选菜单开着时移动高亮' },
  { keys: 'Tab', action: '把高亮候选补进输入框' },
  { keys: 'Enter', action: '提交;参数菜单里是选定并执行' },
  { keys: '@', action: '引用工作区文件' },
  { keys: 'Ctrl+J', action: '输入框内换行' },
  { keys: 'Shift+Tab', action: '循环切换审批模式(ask / auto / yolo)' },
  { keys: 'y / a / n', action: '审批:允许 / 本会话总是允许 / 拒绝' },
  { keys: 'Ctrl+O', action: '全屏查看工具输出' },
  { keys: 'Ctrl+E', action: '展开或折叠工具输出' },
  { keys: 'PgUp / PgDn', action: '滚动对话(鼠标滚轮同)' },
  { keys: 'End', action: '回到底部并继续跟随' },
  { keys: 'Ctrl+C', action: '运行中中断;否则清空输入' },
  { keys: 'Ctrl+D', action: '输入为空时退出' },
  { keys: '?', action: '显示本页(输入框为空时)' },
];

export const CHAT_HELP_TEXT = [
  '/help                 显示帮助',
  '/model [provider/model-id]  查看或切换模型',
  '/effort [off|low|medium|high|xhigh|max]  查看或切换思考强度',
  '/new                  开始新会话',
  '/sessions [会话 id]   恢复会话;无 id 时列出',
  '/compact              立即压缩上下文',
  '/mcp(/mcps)           显示 MCP 服务器状态',
  '/quit                 退出',
  '',
  '快捷键(按 ? 可随时查看):',
  ...CHAT_KEY_HELP.map((row) => `  ${row.keys.padEnd(12)}${row.action}`),
].join('\n');
