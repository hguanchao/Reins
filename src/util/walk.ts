import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 默认跳过的目录:版本库、依赖与产物。 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = ['.git', 'node_modules', 'dist', '.reins'];

export interface WalkOptions {
  /** 额外跳过的目录名。 */
  ignoredDirs?: readonly string[];
  /** 单文件大小上限(字节),超过则跳过,避免把大文件读进内存。 */
  maxFileSize?: number;
  signal?: AbortSignal;
}

/**
 * 递归遍历目录下的普通文件。
 *
 * 设计意图:grep / glob 等工具都需要稳定的遍历顺序与一致的忽略规则,
 * 因此把遍历独立成可复用的异步生成器;全程流式,不一次性收集列表。
 */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<string> {
  const ignored = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  const maxFileSize = options.maxFileSize ?? 1_000_000;
  const stack: string[] = [root];

  while (stack.length > 0) {
    if (options.signal?.aborted) {
      return;
    }
    const dir = stack.pop();
    if (dir === undefined) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (options.signal?.aborted) {
        return;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const info = await stat(fullPath);
        if (info.size > maxFileSize) {
          continue;
        }
      } catch {
        continue;
      }
      yield fullPath;
    }
  }
}
