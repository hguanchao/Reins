import { relative, sep } from 'node:path';
import { DEFAULT_IGNORED_DIRS, walkFiles } from '../util/walk.ts';

/**
 * 工作区文件索引:@ 引用文件选择器的数据源。
 *
 * 设计意图:真正读盘的工作交给 util/walk(与 grep/glob 工具同一条路径),
 * 这里只负责缓存与按需刷新;候选排序是纯函数,与 IO 完全分离以便单测。
 *
 * 候选同时包含文件与目录:目录项统一以 '/' 结尾,既能一眼分辨,
 * 也让「逐级下钻」自然成立——插入目录后查询词变成该目录前缀,菜单继续列出其下内容。
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
  /** 当前快照(目录项以 '/' 结尾);可能为空,刷新是异步的。 */
  list(): readonly string[];
  /** 快照是否已过期(空索引视为始终过期)。 */
  stale(): boolean;
  /** 重新扫描工作区;并发调用只保留一个在途扫描。 */
  refresh(): Promise<void>;
}

/** 目录项的统一表示:路径以 '/' 结尾,用来与文件区分。 */
export function isDirectoryEntry(entry: string): boolean {
  return entry.endsWith('/');
}

/** 从文件路径推导各级祖先目录(带结尾 '/'),去重后排序。 */
function ancestorDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let cut = file.lastIndexOf('/');
    while (cut > 0) {
      dirs.add(`${file.slice(0, cut)}/`);
      cut = file.lastIndexOf('/', cut - 1);
    }
  }
  return [...dirs].sort((left, right) => left.localeCompare(right));
}

export function createFileIndex(root: string, options: FileIndexOptions = {}): FileIndex {
  const limit = options.limit ?? DEFAULT_FILE_LIMIT;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const ignored = options.ignoredDirs;
  let entries: string[] = [];
  let updatedAt = 0;
  let inFlight: Promise<void> | undefined;

  return {
    list: () => entries,
    stale() {
      if (entries.length === 0) {
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
        // 目录由文件路径的祖先推导:有文件的目录都在其中,空目录不进候选
        entries = [...found, ...ancestorDirs(found)];
        updatedAt = Date.now();
      })();
      // 刷新失败时保留旧快照,选择器不至于整体失效
      void inFlight.catch(() => undefined).finally(() => (inFlight = undefined));
      return inFlight;
    },
  };
}

/**
 * 是否该为 @ 补全重新扫描工作区。
 *
 * 判定依据是输入文本(光标是否在 @ 词条内),不是已有候选:索引为空时
 * 不会产生任何候选,拿候选当触发条件就永远等不到第一次扫描。
 */
export function needsFileScan(mentionQuery: string | null, stale: boolean): boolean {
  return mentionQuery !== null && stale;
}

/**
 * 按查询词给候选排序:名称前缀 > 名称包含 > 路径包含,
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
    // 目录项带结尾 '/',比较名称前先剥掉,否则会被当成空名称而永不匹配
    const trimmed = isDirectoryEntry(lower) ? lower.slice(0, -1) : lower;
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    let score: number | undefined;
    if (base.startsWith(needle)) {
      score = 3;
    } else if (base.includes(needle)) {
      score = 2;
    } else if (trimmed.includes(needle)) {
      score = 1;
    }
    if (score !== undefined) {
      scored.push({ file, score: score - Math.min(file.length, 60) / 1000 });
    }
  }
  scored.sort((left, right) => right.score - left.score || (left.file < right.file ? -1 : 1));
  return scored.slice(0, limit).map((entry) => entry.file);
}
