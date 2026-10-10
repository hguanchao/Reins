import { dirname, join } from 'node:path';
import { ensureDir, writeTextFile } from '../util/fsx.ts';

/**
 * 落盘存储:把超长文本写到会话专属目录,返回可读位置。
 *
 * 设计意图:文件按会话隔离,便于清理与审计;
 * 文件名带来源工具与时间戳,便于人工排查。
 */

/**
 * 会话对应的落盘目录:与会话文件同级,名字是 `<会话 id>.spill`。
 *
 * 目录名里带会话 id 而不是「共用一个大目录」,删会话时才能连带清干净、不留孤儿文件。
 */
export function spillDirFor(sessionFile: string, sessionId: string): string {
  return join(dirname(sessionFile), `${sessionId}.spill`);
}
export class SpillStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 保存文本,返回文件路径。 */
  async save(text: string, nameHint = 'result'): Promise<{ path: string }> {
    await ensureDir(this.dir);
    const safeHint = nameHint.replace(/[^A-Za-z0-9_-]/g, '_');
    const name = `${safeHint}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
    const file = join(this.dir, name);
    await writeTextFile(file, text);
    return { path: file };
  }
}
