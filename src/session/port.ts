import type { LlmMessage, LlmUsage } from "../llm/messages.ts";

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

/**
 * 一次请求的用量。
 *
 * 单独记条目而不是挂在消息上：一次请求不一定产出消息（出错与中止就是），而没有用量的请求
 * 也不该在统计里凭空少掉。它不进上下文，只用于统计。
 */
export interface SessionUsageEntry extends SessionEntryBase {
	readonly type: "usage";
	readonly provider: string;
	readonly model: string;
	/** 这笔用量是哪个环节产生的 */
	readonly kind: "turn" | "compact";
	readonly usage: LlmUsage;
}

/**
 * 上下文压缩的检查点。
 *
 * 它把先前那些消息换成一份摘要：折叠时 covered 里的消息不再进入上下文，但条目本身仍留在
 * 文件里，因此用量统计与导出看得到完整历史。covered 记条目 id 而不是条数——条数会随上下文
 * 变化失去意义，id 永远指向同一批消息。
 */
export interface SessionCompactionEntry extends SessionEntryBase {
	readonly type: "compaction";
	readonly summary: string;
	readonly covered: readonly string[];
	/** 产出摘要的 provider 与模型 */
	readonly provider: string;
	readonly model: string;
	/** 压缩前的上下文规模（token）：提供方回报的实际值，没有回报时为估算 */
	readonly tokensBefore: number;
	/** 摘要那次请求的用量；提供方没回报时为空 */
	readonly usage: LlmUsage | undefined;
}

export type SessionEntry =
	| SessionMessageEntry
	| SessionSystemEntry
	| SessionModelChangeEntry
	| SessionEffortChangeEntry
	| SessionUsageEntry
	| SessionCompactionEntry;

export type NewSessionEntry =
	| Omit<SessionMessageEntry, keyof SessionEntryBase>
	| Omit<SessionSystemEntry, keyof SessionEntryBase>
	| Omit<SessionModelChangeEntry, keyof SessionEntryBase>
	| Omit<SessionEffortChangeEntry, keyof SessionEntryBase>
	| Omit<SessionUsageEntry, keyof SessionEntryBase>
	| Omit<SessionCompactionEntry, keyof SessionEntryBase>;

/** 重放条目得到的状态，也就是下一次请求要用的全部信息。 */
export interface SessionState {
	/** 提示词分段。渲染顺序由提示词模块的固定顺序决定，这里只管内容。 */
	readonly sections: Readonly<Record<string, string>>;
	readonly tools: readonly SessionToolDeclaration[];
	readonly messages: readonly LlmMessage[];
	/** 与 messages 一一对应。压缩要按条目记录覆盖范围，而消息本身不带 id。 */
	readonly messageIds: readonly string[];
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
