import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeSessionFile, type SessionSummary } from '../../session/store.ts';
import { ReinsError, describeError } from '../../util/errors.ts';
import { reinsHome } from '../../util/paths.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/**
 * sessions 子命令:列出历史会话,并提供会话引用解析。
 *
 * 设计意图:列表只做读操作、逐文件容错;引用解析支持「id 前缀」与「文件路径」两种写法,
 * 让 `reins run --resume` 的结果可以直接粘给下一个人。
 */
export async function sessionsCommand(args: ParsedArgs, io: CommandIo = defaultIo): Promise<number> {
  const action = args.positionals[0] ?? 'list';
  if (action === 'list') {
    return await listSessions(join(reinsHome(), 'sessions'), args, io);
  }
  io.err(`未知子命令:sessions ${action}(可用:list)`);
  return 1;
}

async function listSessions(dir: string, args: ParsedArgs, io: CommandIo): Promise<number> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    io.out('还没有任何会话。');
    return 0;
  }

  const summaries: SessionSummary[] = [];
  for (const name of files) {
    try {
      summaries.push(await summarizeSessionFile(join(dir, name)));
    } catch (error) {
      io.out(`(跳过无法读取的会话 ${name}:${describeError(error)})`);
    }
  }
  summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const rawLimit = typeof args.flags['limit'] === 'string' ? Number(args.flags['limit']) : 20;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;
  const shown = summaries.slice(0, limit);
  if (shown.length === 0) {
    io.out('还没有任何会话。');
    return 0;
  }
  for (const summary of shown) {
    const when = summary.createdAt.replace('T', ' ').slice(0, 19);
    io.out(`${summary.sessionId}  ${when}  ${summary.entryCount} 条  ${summary.preview}`);
  }
  io.out(`共 ${summaries.length} 个会话;用 reins run --resume <会话 id> 继续。`);
  return 0;
}

/** 把会话引用(id 前缀或文件路径)解析为会话文件路径。 */
export async function resolveSessionFile(home: string, reference: string): Promise<string> {
  if (reference.includes('/') || reference.includes('\\') || reference.endsWith('.jsonl')) {
    return reference;
  }
  const dir = join(home, 'sessions');
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  const match = files.find((name) => name.startsWith(reference) || name === `${reference}.jsonl`);
  if (match === undefined) {
    throw new ReinsError('session', `找不到会话:${reference}`, '运行 `reins sessions list` 查看可用的会话。');
  }
  return join(dir, match);
}
