import { ReinsError } from '../util/errors.ts';
import { makeEntryId, SessionStore, type SessionEntry, type StoredToolCall } from './store.ts';

/**
 * 会话树:条目通过 parentId 串成树,叶子指针决定「当前分支」。
 *
 * 设计意图:继续一个旧条目 = 在旧条目后长出新的分支;
 * 模型看到的历史永远是「根到当前叶子」这一条路径。
 */

export type SessionEntryInput =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; toolCalls: StoredToolCall[] }
  | { type: 'tool_result'; toolCallId: string; name: string; content: string; isError: boolean }
  | { type: 'summary'; text: string };

export class Session {
  readonly store: SessionStore;
  private entries: SessionEntry[];
  private leafId: string | null;

  private constructor(store: SessionStore, entries: SessionEntry[], leafId: string | null) {
    this.store = store;
    this.entries = entries;
    this.leafId = leafId;
  }

  /** 新建会话。 */
  static async create(dir: string, cwd: string): Promise<Session> {
    const store = await SessionStore.create(dir, cwd);
    return new Session(store, [], null);
  }

  /** 恢复已有会话。 */
  static async resume(file: string): Promise<Session> {
    const store = await SessionStore.open(file);
    const { entries } = await store.readAll();
    const last = entries[entries.length - 1];
    return new Session(store, entries, last === undefined ? null : last.id);
  }

  get id(): string {
    return this.store.sessionId;
  }

  get path(): string {
    return this.store.file;
  }

  get leaf(): string | null {
    return this.leafId;
  }

  /** 追加条目,默认挂在当前叶子下。 */
  async append(input: SessionEntryInput): Promise<SessionEntry> {
    const entry = {
      ...input,
      id: makeEntryId(),
      parentId: this.leafId,
      ts: new Date().toISOString(),
    } as SessionEntry;
    await this.store.append(entry);
    this.entries.push(entry);
    this.leafId = entry.id;
    return entry;
  }

  /** 把活动叶子切到指定条目;之后追加的内容形成新分支。 */
  branchFrom(id: string): void {
    if (!this.entries.some((entry) => entry.id === id)) {
      throw new ReinsError('session', `会话中找不到条目:${id}`);
    }
    this.leafId = id;
  }

  /** 根到当前叶子的路径,即下一次请求携带的历史。 */
  activeBranch(): SessionEntry[] {
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const branch: SessionEntry[] = [];
    let cursor = this.leafId;
    while (cursor !== null) {
      const entry = byId.get(cursor);
      if (entry === undefined) {
        break;
      }
      branch.push(entry);
      cursor = entry.parentId;
    }
    return branch.reverse();
  }

  /** 全部条目(含其他分支),用于展示与回放。 */
  get allEntries(): SessionEntry[] {
    return [...this.entries];
  }
}
