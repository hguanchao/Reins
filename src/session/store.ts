import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ReinsError } from '../util/errors.ts';
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
}

export interface SessionFile {
  meta: SessionMeta;
  entries: SessionEntry[];
}

/** 生成短随机标识。 */
export function makeEntryId(): string {
  return randomUUID().slice(0, 12);
}

export class SessionStore {
  readonly file: string;
  private metaValue: SessionMeta | undefined;

  constructor(file: string) {
    this.file = file;
  }

  /** 新建会话文件并写入 meta。 */
  static async create(dir: string, cwd: string): Promise<SessionStore> {
    await ensureDir(dir);
    const sessionId = `s-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const store = new SessionStore(join(dir, `${sessionId}.jsonl`));
    await store.writeMeta({
      v: SESSION_FORMAT_VERSION,
      type: 'meta',
      sessionId,
      createdAt: new Date().toISOString(),
      cwd,
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
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      throw new ReinsError('session', `会话文件为空:${this.file}`);
    }
    const meta = this.parseLine(lines[0] as string, 1) as SessionMeta;
    if (meta.type !== 'meta' || typeof meta.v !== 'number') {
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
    for (let index = 1; index < lines.length; index += 1) {
      entries.push(this.parseLine(lines[index] as string, index + 1) as SessionEntry);
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
