import { relative, sep } from 'node:path';
import { DEFAULT_IGNORED_DIRS, walkFiles } from '../util/walk.ts';

/**
 * 工作区文件索引:@ 引用文件选择器的数据源。
 *
 * 设计意图:真正读盘的工作交给 util/walk(与 grep/glob 工具同一条路径),
 * 这里只负责缓存与按需刷新;候选排序是纯函数,与 IO 完全分离以便单测。
 */

/** 默认索引上限:超大仓库不做全量列举,够补全用即可。 */
const DEFAULT_FILE_LIMIT = 20_000;
/** 缓存有效期:超过后才在下次触发 @ 时重新扫描。 */
const DEFAULT_TTL_MS = 30_000;

export interface FileIndexOptions {
  limit?: number;
  ttlMs?: number;
  /** 额外忽略的目录名(在 walk 默认忽略之外)。 */
  ignoredDirs?: readonly string[];
}

export interface FileIndex {
  /** 当前快照;可能为空,刷新是异步的。 */
  list(): readonly string[];
  /** 快照是否已过期(空索引视为始终过期)。 */
  stale(): boolean;
  /** 重新扫描工作区;并发调用只保留一个在途扫描。 */
  refresh(): Promise<void>;
}

export function createFileIndex(root: string, options: FileIndexOptions = {}): FileIndex {
  const limit = options.limit ?? DEFAULT_FILE_LIMIT;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const ignored = options.ignoredDirs;
  let files: string[] = [];
  let updatedAt = 0;
  let inFlight: Promise<void> | undefined;

  return {
    list: () => files,
    stale() {
      if (files.length === 0) {
        return true;
      }
      return Date.now() - updatedAt > ttlMs;
    },
    refresh() {
      if (inFlight !== undefined) {
        return inFlight;
      }
      inFlight = (async () => {
        const found: string[] = [];
        for await (const absolute of walkFiles(root, { ignoredDirs: ignored ?? DEFAULT_IGNORED_DIRS })) {
          found.push(relative(root, absolute).split(sep).join('/'));
          if (found.length >= limit) {
            break;
          }
        }
        found.sort((left, right) => left.localeCompare(right));
        files = found;
        updatedAt = Date.now();
      })();
      // 刷新失败时保留旧快照,选择器不至于整体失效
      void inFlight.catch(() => undefined).finally(() => (inFlight = undefined));
      return inFlight;
    },
  };
}

/**
 * 按查询词给文件候选排序:文件名前缀 > 文件名包含 > 路径包含,
 * 同分时短路径优先;空查询按字典序取前 limit 个。
 */
export function rankFileCandidates(
  files: readonly string[],
  query: string,
  limit: number,
): string[] {
  if (limit <= 0) {
    return [];
  }
  const needle = query.toLowerCase().replace(/\\/g, '/');
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    if (needle === '') {
      scored.push({ file, score: 0 });
      continue;
    }
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score: number | undefined;
    if (base.startsWith(needle)) {
      score = 3;
    } else if (base.includes(needle)) {
      score = 2;
    } else if (lower.includes(needle)) {
      score = 1;
    }
    if (score !== undefined) {
      scored.push({ file, score: score - Math.min(file.length, 60) / 1000 });
    }
  }
  scored.sort((left, right) => right.score - left.score || (left.file < right.file ? -1 : 1));
  return scored.slice(0, limit).map((entry) => entry.file);
}
