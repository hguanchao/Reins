import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ReinsError } from '../util/errors.ts';
import { uuidv7 } from '../util/ids.ts';
import { appendLine, ensureDir, pathExists, readTextFile } from '../util/fsx.ts';

/**
 * 会话存储:JSONL 追加写入。
 *
 * 设计意图:一步一行、只追加不改写——天然可审计、可回放、可被 git 管理;
 * 首行 meta 带格式版本,为格式演进留出空间。
 */

/** 会话文件格式版本。 */
export const SESSION_FORMAT_VERSION = 1;

export interface StoredToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  ts: string;
}

export interface UserEntry extends SessionEntryBase {
  type: 'user';
  text: string;
}

export interface AssistantEntry extends SessionEntryBase {
  type: 'assistant';
  text: string;
  toolCalls: StoredToolCall[];
}

export interface ToolResultEntry extends SessionEntryBase {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

export interface SummaryEntry extends SessionEntryBase {
  type: 'summary';
  text: string;
}

export type SessionEntry = UserEntry | AssistantEntry | ToolResultEntry | SummaryEntry;

export interface SessionMeta {
  v: number;
  type: 'meta';
  sessionId: string;
  createdAt: string;
  cwd: string;
  /** 本次会话是否在受信任的项目里创建;审计用,旧文件缺此字段。 */
  trusted?: boolean;
}

export interface SessionFile {
  meta: SessionMeta;
  entries: SessionEntry[];
}

/** 生成短随机标识。 */
export function makeEntryId(): string {
  return randomUUID().slice(0, 12);
}

/**
 * 把项目路径编码为会话目录名:如 E:\Projects\Reins → E--Projects-Reins。
 *
 * 注意:该映射把 `/ \ : * ? " < > |` 统一压成 `-`,因而不是单射——`E:\a\b` 与
 * `E:\a-b` 会落到同一目录。因此按会话定位时不能只看目录名,必须再用 meta.cwd
 * 过滤(见 sessions.ts),否则会取到别的项目的会话。
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[<>:"/\\|?*]/g, '-');
}

export class SessionStore {
  readonly file: string;
  private metaValue: SessionMeta | undefined;

  constructor(file: string) {
    this.file = file;
  }

  /** 新建会话:按项目分目录,文件名就是会话 id(v7 名字序即时间序)。 */
  static async create(dir: string, cwd: string, trusted = false): Promise<SessionStore> {
    const projectDir = join(dir, encodeProjectDir(cwd));
    await ensureDir(projectDir);
    const sessionId = uuidv7();
    const store = new SessionStore(join(projectDir, `${sessionId}.jsonl`));
    await store.writeMeta({
      v: SESSION_FORMAT_VERSION,
      type: 'meta',
      sessionId,
      createdAt: new Date().toISOString(),
      cwd,
      trusted,
    });
    return store;
  }

  /** 打开已有会话文件。 */
  static async open(file: string): Promise<SessionStore> {
    if (!(await pathExists(file))) {
      throw new ReinsError('session', `会话文件不存在:${file}`);
    }
    const store = new SessionStore(file);
    const parsed = await store.readAll();
    store.metaValue = parsed.meta;
    return store;
  }

  get sessionId(): string {
    if (this.metaValue === undefined) {
      throw new ReinsError('session', '会话尚未初始化');
    }
    return this.metaValue.sessionId;
  }

  get meta(): SessionMeta {
    if (this.metaValue === undefined) {
      throw new ReinsError('session', '会话尚未初始化');
    }
    return this.metaValue;
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    this.metaValue = meta;
    await appendLine(this.file, JSON.stringify(meta));
  }

  /** 追加一条条目。 */
  async append(entry: SessionEntry): Promise<void> {
    await appendLine(this.file, JSON.stringify(entry));
  }

  /** 读取全部内容;损坏的行会指出具体行号。 */
  async readAll(): Promise<SessionFile> {
    const text = await readTextFile(this.file);
    // 保留原始行号:空行也要占位,否则报出的行号与编辑器里看到的不一致
    const rawLines = text.split(/\r?\n/);
    const firstIndex = rawLines.findIndex((line) => line.trim() !== '');
    if (firstIndex === -1) {
      throw new ReinsError('session', `会话文件为空:${this.file}`);
    }
    const meta = this.parseLine(rawLines[firstIndex] as string, firstIndex + 1);
    if (!isMeta(meta)) {
      throw new ReinsError('session', `会话文件缺少有效的 meta 行:${this.file}`);
    }
    if (meta.v > SESSION_FORMAT_VERSION) {
      throw new ReinsError(
        'session',
        `会话格式版本 ${meta.v} 高于当前支持的 ${SESSION_FORMAT_VERSION}`,
        '请升级 Reins 后再打开该会话。',
      );
    }
    const entries: SessionEntry[] = [];
    for (let index = firstIndex + 1; index < rawLines.length; index += 1) {
      const line = rawLines[index] as string;
      if (line.trim() === '') {
        continue;
      }
      entries.push(this.parseLine(line, index + 1) as SessionEntry);
    }
    return { meta, entries };
  }

  private parseLine(line: string, lineNumber: number): unknown {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new ReinsError('session', `会话文件第 ${lineNumber} 行不是合法 JSON:${this.file}`);
    }
  }
}

/** 判断解析结果是否是合法的 meta 行(解析出的 null 也要拦住,否则读属性会抛 TypeError)。 */
function isMeta(value: unknown): value is SessionMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['type'] === 'meta' &&
    typeof (value as Record<string, unknown>)['v'] === 'number'
  );
}

/** 会话文件摘要(用于列表展示)。 */
export interface SessionSummary {
  file: string;
  sessionId: string;
  createdAt: string;
  cwd: string;
  entryCount: number;
  preview: string;
}

/** 读取会话文件的轻量摘要。 */
export async function summarizeSessionFile(file: string): Promise<SessionSummary> {
  const store = new SessionStore(file);
  const { meta, entries } = await store.readAll();
  const firstUser = entries.find((entry): entry is UserEntry => entry.type === 'user');
  const preview =
    firstUser === undefined
      ? '(无用户消息)'
      : (firstUser.text.split('\n')[0] ?? '').slice(0, 60);
  return {
    file,
    sessionId: meta.sessionId,
    createdAt: meta.createdAt,
    cwd: meta.cwd,
    entryCount: entries.length,
    preview,
  };
}
