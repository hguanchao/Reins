import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import type {
	NewSessionEntry,
	SessionEntry,
	SessionPort,
	SessionState,
	SessionToolDeclaration,
} from "../../session/port.ts";
import type { LlmMessage } from "../../llm/messages.ts";
import { splitLines } from "../../tools/truncate.ts";
import { SessionLock } from "./lock.ts";

/**
 * 以 JSONL 保存会话。
 *
 * 每行一条记录，条目之间用 id 与 parentId 串成树——即使当前只沿一条路径追加，树结构也从
 * 第一天就写进文件：事后要补分支只能改文件格式，而树的代价只是每条多一个字段。
 *
 * 文件在第一次追加时才创建，首行是会话头。这样只是查看配置或帮助时不会留下一堆空会话。
 */

/** 条目格式的版本。日后若要调整字段含义，靠它决定怎么读旧文件。 */
export const SESSION_VERSION = 1;

export interface JsonlSessionOptions {
	/** 会话文件路径；传 null 则只保存在内存里 */
	readonly file: string | null;
	readonly id: string;
	readonly cwd: string;
}

/** 折叠中的可变状态。entries 只增不改，所以这里可以增量维护，不必每次重放。 */
interface MutableState {
	sections: Record<string, string>;
	tools: SessionToolDeclaration[];
	messages: LlmMessage[];
	model: { provider: string; model: string } | undefined;
	effort: string | undefined;
}

export class JsonlSession implements SessionPort {
	readonly id: string;
	readonly cwd: string;
	readonly path: string | null;

	readonly #entries: SessionEntry[] = [];
	readonly #state: MutableState = {
		sections: {},
		tools: [],
		messages: [],
		model: undefined,
		effort: undefined,
	};
	readonly #ids = new Set<string>();
	/** 锁与文件一样，到真正要写的时候才建立：只构造不使用不该留下任何痕迹 */
	#lock: SessionLock | null = null;
	#leafId: string | null = null;
	#headerWritten = false;
	#closed = false;

	constructor(options: JsonlSessionOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.path = options.file;
	}

	get entryCount(): number {
		return this.#entries.length;
	}

	async append(entry: NewSessionEntry): Promise<void> {
		if (this.#closed) throw new Error("会话已关闭");

		const id = this.#nextId();
		const complete = {
			...entry,
			id,
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
		} as SessionEntry;

		if (this.path !== null) this.#write(complete);
		this.#entries.push(complete);
		this.#leafId = id;
		applyEntry(this.#state, complete);
	}

	entries(): readonly SessionEntry[] {
		return this.#entries;
	}

	/** 重放后的状态。数组做一次浅拷贝，避免调用方持有内部数组。 */
	state(): SessionState {
		return {
			sections: { ...this.#state.sections },
			tools: [...this.#state.tools],
			messages: [...this.#state.messages],
			model: this.#state.model,
			effort: this.#state.effort,
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#lock?.release();
	}

	#write(entry: SessionEntry): void {
		const path = this.path;
		if (path === null) return;

		try {
			if (!this.#headerWritten) {
				mkdirSync(dirname(path), { recursive: true });
				// 取锁要在写第一条之前：两个进程交错追加会得到两段各自完整、顺序却不是任何
				// 一方以为的历史
				this.#lock = SessionLock.acquire(path);
				// 独占创建：文件已存在说明会话标识撞上了，这种情况必须报错而不是接着写
				const handle = openSync(path, "wx");
				writeSync(handle, `${JSON.stringify(headerOf(this.id, this.cwd))}\n`);
				closeSync(handle);
				this.#headerWritten = true;
			}
			appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
		} catch (error) {
			// 写失败时把锁还回去，否则这个会话在本进程里再也打不开了
			this.#lock?.release();
			this.#lock = null;
			throw new Error(`写入会话文件失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#nextId(): string {
		for (;;) {
			const id = randomBytes(4).toString("hex");
			if (!this.#ids.has(id)) {
				this.#ids.add(id);
				return id;
			}
		}
	}
}

interface SessionHeaderLine {
	readonly type: "session";
	readonly version: number;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
}

function headerOf(id: string, cwd: string): SessionHeaderLine {
	return { type: "session", version: SESSION_VERSION, id, timestamp: new Date().toISOString(), cwd };
}

/**
 * 从若干条目折叠出状态。
 *
 * 会话的写入方增量维护同一份状态，这里提供的是「只看条目也能得到同样结果」的那条路径。
 * 它是会话格式的核心约定：下一次请求要用的东西全部来自这些记录，没有任何藏在内存里的补充，
 * 因此把文件从头重放一遍就能得到当时发出去的请求。
 */
export function foldEntries(entries: readonly SessionEntry[]): SessionState {
	const state: MutableState = { sections: {}, tools: [], messages: [], model: undefined, effort: undefined };
	for (const entry of entries) applyEntry(state, entry);
	return {
		sections: { ...state.sections },
		tools: [...state.tools],
		messages: [...state.messages],
		model: state.model,
		effort: state.effort,
	};
}

export interface ParsedSessionFile {
	readonly header: SessionHeaderLine | undefined;
	readonly entries: readonly SessionEntry[];
	/** 解析不了的行数。文件被外部改动过时用它判断完整性。 */
	readonly skippedLines: number;
}

/** 解析会话文件内容。首行是会话头，其余每行一条条目。 */
export function parseSessionText(text: string): ParsedSessionFile {
	const entries: SessionEntry[] = [];
	let header: SessionHeaderLine | undefined;
	let skippedLines = 0;

	for (const line of splitLines(text)) {
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			skippedLines += 1;
			continue;
		}
		if ((parsed as { type?: unknown }).type === "session") {
			header = parsed as SessionHeaderLine;
			continue;
		}
		entries.push(parsed as SessionEntry);
	}

	return { header, entries, skippedLines };
}

function applyEntry(state: MutableState, entry: SessionEntry): void {
	switch (entry.type) {
		case "message":
			state.messages.push(entry.message);
			return;
		case "system":
			for (const [name, body] of Object.entries(entry.sections)) {
				if (body === null) delete state.sections[name];
				else state.sections[name] = body;
			}
			for (const name of entry.toolsRemoved ?? []) {
				state.tools = state.tools.filter((tool) => tool.name !== name);
			}
			for (const tool of entry.toolsAdded ?? []) {
				state.tools = [...state.tools.filter((item) => item.name !== tool.name), tool];
			}
			return;
		case "model_change":
			state.model = { provider: entry.provider, model: entry.model };
			return;
		case "effort_change":
			state.effort = entry.effort;
			return;
	}
}
