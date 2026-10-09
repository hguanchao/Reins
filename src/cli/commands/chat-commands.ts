/**
 * 聊天命令:斜杠命令解析与补全(纯文本与 TUI 两种模式共用)。
 *
 * 设计意图:全部保持纯函数,便于单测;UI 层只负责呈现与执行。
 */

export type ChatCommand =
  | { type: 'exit' }
  | { type: 'help' }
  | { type: 'session' }
  | { type: 'status' }
  | { type: 'new' }
  | { type: 'compact' }
  | { type: 'mcp' }
  | { type: 'model'; target: string | undefined }
  | { type: 'resume'; id: string | undefined }
  | { type: 'empty' }
  | { type: 'prompt'; text: string };

/** 可补全的斜杠命令集合。 */
export const CHAT_COMMANDS: readonly string[] = [
  '/clear',
  '/compact',
  '/exit',
  '/help',
  '/mcp',
  '/model',
  '/new',
  '/quit',
  '/resume',
  '/session',
  '/sessions',
  '/status',
];

/**
 * 斜杠命令的说明,供补全菜单逐条展示。
 *
 * 别名(/clear、/quit、/sessions)与主命令共用同一句说明,菜单里不区分。
 */
export const CHAT_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/clear': '开始新会话',
  '/compact': '立即压缩上下文',
  '/exit': '退出',
  '/help': '显示帮助',
  '/mcp': '显示 MCP 服务器状态',
  '/model': '查看或切换模型',
  '/new': '开始新会话',
  '/quit': '退出',
  '/resume': '恢复会话;无 id 时列出',
  '/session': '显示当前会话文件',
  '/sessions': '恢复会话;无 id 时列出',
  '/status': '显示会话与模型状态',
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
    case 'exit':
    case 'quit':
      return { type: 'exit' };
    case 'help':
    case 'hotkeys':
      return { type: 'help' };
    case 'session':
      return { type: 'session' };
    case 'status':
      return { type: 'status' };
    case 'new':
    case 'clear':
      return { type: 'new' };
    case 'compact':
      return { type: 'compact' };
    case 'mcp':
    case 'mcps':
      return { type: 'mcp' };
    case 'model':
    case 'm':
      return { type: 'model', target: arg };
    case 'resume':
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

export const CHAT_HELP_TEXT = [
  '/help                 显示帮助',
  '/new(/clear)          开始新会话',
  '/model [provider/model-id]  查看或切换模型',
  '/compact              立即压缩上下文',
  '/status               显示会话与模型状态',
  '/mcp(/mcps)           显示 MCP 服务器状态',
  '/resume(/sessions) [会话 id]  恢复会话;无 id 时列出',
  '/session              显示当前会话文件',
  '/exit(/quit)          退出',
  '',
  '快捷键:↑/↓ 历史 · @ 引用文件 · Tab 补全 · Ctrl+J 换行',
  '        Ctrl+O 全屏查看工具输出 · Ctrl+E 展开或折叠 · Ctrl+C/Esc 中断 · 空行 Ctrl+D 退出',
  '        PgUp/PgDn/滚轮 滚动 · End 回到底部',
].join('\n');
