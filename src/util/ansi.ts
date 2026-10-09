/**
 * ANSI 转义:SGR 序列的包裹与剥离。
 *
 * 设计意图:保持纯函数、零依赖,不认识任何业务概念,供 tui 排版层复用。
 */

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** 去掉文本中的 SGR 样式序列。 */
export function stripSgr(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 净化外部文本(模型输出、工具输出、错误信息),供终端原样显示。
 *
 * 为什么需要:这些文本不受信任,里面的 ESC 序列会被终端当作控制指令执行
 * (清屏、改标题、写剪贴板),既造成界面错乱,也是一条注入面;同时控制字符
 * 不占显示宽度却会让排版算错列。这里统一剥掉转义序列与 C0/C1 控制符,
 * 保留 \n 与 \t(排版层需要换行与制表)。
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI:光标、清屏、SGR 等
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC:标题、剪贴板等
    .replace(/\u001b[@-Z\\-_]/g, '') // 其余双字符转义
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''); // 残余 C0/C1(含孤立 ESC)
}

/** 用 SGR 序列包裹文本;codes 为空时原样返回(无色环境)。 */
export function sgr(codes: string, text: string): string {
  return codes === '' ? text : `\u001b[${codes}m${text}\u001b[0m`;
}
