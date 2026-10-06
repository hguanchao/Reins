import { spawn } from 'node:child_process';
import type { NotifyMode } from '../config/schema.ts';

/**
 * 系统通知。
 *
 * 语义与配置一致:auto = 响铃 + 桌面通知;bell = 只响铃;desktop = 只桌面通知;off = 关闭。
 * 桌面通知优先使用终端 OSC 9 转义序列(现代终端均支持),并在 macOS/Linux 追加系统级兜底。
 */

export function notify(
  mode: NotifyMode,
  message: string,
  out: (text: string) => void = (text) => process.stdout.write(text),
): void {
  if (mode === 'off') {
    return;
  }
  if (mode === 'bell' || mode === 'auto') {
    out('\u0007');
  }
  if (mode === 'desktop' || mode === 'auto') {
    out(`\u001b]9;${sanitize(message)}\u0007`);
    spawnDesktopFallback(message);
  }
}

function sanitize(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

function spawnDesktopFallback(message: string): void {
  try {
    const command =
      process.platform === 'darwin'
        ? { file: 'osascript', args: ['-e', `display notification ${JSON.stringify(message)}`] }
        : process.platform === 'linux'
          ? { file: 'notify-send', args: ['Reins', message] }
          : null;
    if (command === null) {
      return;
    }
    const child = spawn(command.file, command.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 通知失败不影响主流程
  }
}
