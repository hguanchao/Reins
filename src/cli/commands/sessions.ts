import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { encodeProjectDir, summarizeSessionFile, type SessionSummary } from '../../session/store.ts';
import { ReinsError } from '../../util/errors.ts';
import { reinsHome } from '../../util/paths.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/**
 * sessions 子命令:列出历史会话,并提供会话引用解析。
 *
 * 设计意图:会话按项目分目录存放,列表与解析都兼容旧版扁平布局;
 * 引用解析支持「id 前缀」与「文件路径」两种写法。
 */
export async function sessionsCommand(
  args: ParsedArgs,
  io: CommandIo = defaultIo,
  home = reinsHome(),
): Promise<number> {
  const action = args.positionals[0] ?? 'list';
  if (action === 'list') {
    return await listSessions(home, args, io);
  }
  io.err(`未知子命令:sessions ${action}(可用:list)`);
  return 1;
}

/** 收集全部会话文件(~/.reins/sessions/<项目>/*.jsonl,兼容旧布局的根级文件)。 */
async function collectSessionFiles(home: string): Promise<string[]> {
  const dir = join(home, 'sessions');
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
      continue;
    }
    if (entry.isDirectory()) {
      let inner;
      try {
        inner = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of inner) {
        if (child.isFile() && child.name.endsWith('.jsonl')) {
          files.push(join(full, child.name));
        }
      }
    }
  }
  return files;
}

/** 扫描全部会话并生成摘要,按创建时间从新到旧排序(损坏文件跳过)。 */
export async function listSessionSummaries(home: string): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = [];
  for (const file of await collectSessionFiles(home)) {
    try {
      summaries.push(await summarizeSessionFile(file));
    } catch {
      // 损坏的会话跳过,不阻断列表
    }
  }
  summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return summaries;
}

/** 最近一次更新的会话文件(按文件修改时间)。 */
export async function latestSessionFile(home: string): Promise<string | undefined> {
  const files = await collectSessionFiles(home);
  if (files.length === 0) {
    return undefined;
  }
  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, time: (await stat(file)).mtimeMs };
      } catch {
        return { file, time: 0 };
      }
    }),
  );
  entries.sort((left, right) => right.time - left.time);
  return entries[0]?.file;
}

async function listSessions(home: string, args: ParsedArgs, io: CommandIo): Promise<number> {
  const summaries = await listSessionSummaries(home);
  if (summaries.length === 0) {
    io.out('还没有任何会话。');
    return 0;
  }
  const rawLimit = typeof args.flags['limit'] === 'string' ? Number(args.flags['limit']) : 20;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;
  for (const summary of summaries.slice(0, limit)) {
    const when = summary.createdAt.replace('T', ' ').slice(0, 19);
    const project = encodeProjectDir(summary.cwd);
    io.out(`${summary.sessionId}  ${when}  ${summary.entryCount} 条  ${project}  ${summary.preview}`);
  }
  io.out(`共 ${summaries.length} 个会话;用 reins run --resume <会话 id> 继续。`);
  return 0;
}

/** 把会话引用(id 前缀或文件路径)解析为会话文件路径。 */
export async function resolveSessionFile(home: string, reference: string): Promise<string> {
  if (reference.includes('/') || reference.includes('\\') || reference.endsWith('.jsonl')) {
    return reference;
  }
  const matches: string[] = [];
  for (const file of await collectSessionFiles(home)) {
    const stem = basename(file).replace(/\.jsonl$/, '');
    if (stem === reference || stem.startsWith(reference)) {
      matches.push(file);
    }
  }
  if (matches.length === 0) {
    throw new ReinsError('session', `找不到会话:${reference}`, '运行 `reins sessions list` 查看可用的会话。');
  }
  if (matches.length === 1) {
    return matches[0] as string;
  }
  // 多个前缀命中时取最新写入的一个
  const entries = await Promise.all(
    matches.map(async (file) => {
      try {
        return { file, time: (await stat(file)).mtimeMs };
      } catch {
        return { file, time: 0 };
      }
    }),
  );
  entries.sort((left, right) => right.time - left.time);
  return entries[0]?.file as string;
}
