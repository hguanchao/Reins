import type { LlmMessage, LlmStopReason, LlmUsage } from "../llm/messages.ts";

/**
 * 会话端口的契约。
 *
 * 条目用 id/parentId 串成树，从第一天就是这样：线性历史之后要补分支只能靠改文件格式，
 * 而树的代价只是每条多存一个字段。当前只用到「沿一条路径追加」，分支导航随后再加。
 */

export interface SessionEntryBase {
	readonly id: string;
	/** 父条目；根条目为 null */
	readonly parentId: string | null;
	/** ISO 时间戳 */
	readonly timestamp: string;
}

/** 文件首行，只有元信息，不属于条目树。 */
export interface SessionHeaderEntry {
	readonly type: "session";
	/** 条目格式的版本号，便于日后迁移旧文件 */
	readonly version: number;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	readonly type: "message";
	readonly message: LlmMessage;
}

/**
 * 提示词与工具声明的增量。
 *
 * 它们不放在请求里现算，而是作为会话状态的一部分记下来：每请求重算会让「当时用的提示词」
 * 无从查证，也会让压缩时的检查点对不上。sections 里值为 null 表示移除那一段。
 */
export interface SessionSystemEntry extends SessionEntryBase {
	readonly type: "system";
	readonly sections: Readonly<Record<string, string | null>>;
	readonly toolsAdded?: readonly SessionToolDeclaration[];
	readonly toolsRemoved?: readonly string[];
}

export interface SessionToolDeclaration {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
}

export interface SessionModelChangeEntry extends SessionEntryBase {
	readonly type: "model_change";
	readonly provider: string;
	readonly model: string;
}

export interface SessionEffortChangeEntry extends SessionEntryBase {
	readonly type: "effort_change";
	readonly effort: string;
}

export type SessionEntry =
	| SessionMessageEntry
	| SessionSystemEntry
	| SessionModelChangeEntry
	| SessionEffortChangeEntry;

export type NewSessionEntry =
	| Omit<SessionMessageEntry, keyof SessionEntryBase>
	| Omit<SessionSystemEntry, keyof SessionEntryBase>
	| Omit<SessionModelChangeEntry, keyof SessionEntryBase>
	| Omit<SessionEffortChangeEntry, keyof SessionEntryBase>;

/** 重放条目得到的状态，也就是下一次请求要用的全部信息。 */
export interface SessionState {
	/** 提示词分段。渲染顺序由提示词模块的固定顺序决定，这里只管内容。 */
	readonly sections: Readonly<Record<string, string>>;
	readonly tools: readonly SessionToolDeclaration[];
	readonly messages: readonly LlmMessage[];
	readonly model: { readonly provider: string; readonly model: string } | undefined;
	readonly effort: string | undefined;
}

/** 工具能看到的会话信息：只够把会话标识透给子进程，改不了任何东西。 */
export interface SessionReadView {
	readonly id: string;
	/** 落盘位置；内存会话为 null */
	readonly path: string | null;
}

export interface SessionPort {
	readonly id: string;
	readonly cwd: string;
	readonly path: string | null;
	append(entry: NewSessionEntry): Promise<void>;
	/** 全量条目，含已被移出当前上下文的历史 */
	entries(): readonly SessionEntry[];
	/** 重放出的当前状态 */
	state(): SessionState;
	close(): Promise<void>;
}
