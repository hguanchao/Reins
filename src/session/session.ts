import { randomBytes } from "node:crypto";

import { SessionFolder } from "./fold.ts";
import {
	SESSION_VERSION,
	type ForkOrigin,
	type NewSessionEntry,
	type SessionEntry,
	type SessionPort,
	type SessionState,
} from "./port.ts";
import type { SessionStore, SessionWriter } from "./store.ts";
import { leavesOf, pathTo } from "./tree.ts";

/**
 * 会话。
 *
 * 条目用 id/parentId 串成树，写入时只沿当前叶子追加，文件里因此天然是一条路径。落盘交给
 * 写入器：会话本身只负责条目、叶子与折叠出的状态，所以同一套语义既能写进 JSONL，也能只留在
 * 内存里。
 *
 * 续聊是把既有条目读进来接着写；分叉是把某个会话的一条路径复制成一个新会话——原会话一个
 * 字节都不动。
 */

interface SessionOptions {
	readonly id: string;
	readonly cwd: string;
	/** 落盘位置；null 表示只在内存里 */
	readonly file: string | null;
	/** 落盘通道。file 非 null 时必须给：没有通道就写不下去，这件事必须在构造时暴露 */
	readonly writer?: SessionWriter;
	/** 既有历史：续聊与分叉都从这里进来，叶子取最后一条路径的末尾 */
	readonly entries?: readonly SessionEntry[];
}

export class Session implements SessionPort {
	readonly id: string;
	readonly cwd: string;
	readonly path: string | null;

	readonly #entries: SessionEntry[] = [];
	readonly #folder = new SessionFolder();
	readonly #ids = new Set<string>();
	readonly #writer: SessionWriter | undefined;
	#leafId: string | null = null;
	#closed = false;

	constructor(options: SessionOptions) {
		if (options.file !== null && options.writer === undefined) {
			throw new Error("Writing a session to a file requires a session store");
		}
		this.id = options.id;
		this.cwd = options.cwd;
		this.path = options.file;
		this.#writer = options.writer;

		for (const entry of options.entries ?? []) {
			this.#entries.push(entry);
			this.#ids.add(entry.id);
			this.#folder.add(entry);
		}
		const leaves = leavesOf(this.#entries);
		this.#leafId = leaves.length === 0 ? null : (leaves[leaves.length - 1]?.id ?? null);
	}

	/** 接续一个既有会话文件。读出来的条目已经在文件里，不会再写一遍。 */
	static open(file: string, store: SessionStore): Session {
		const opened = store.read(file);
		if (opened.header === undefined) {
			throw new Error(`Session file has no header line and cannot be resumed: ${file}`);
		}
		if (opened.header.version !== SESSION_VERSION) {
			throw new Error(
				`Session file version ${opened.header.version} does not match the current version ${SESSION_VERSION} and cannot be resumed: ${file}`,
			);
		}
		return new Session({
			id: opened.header.id,
			cwd: opened.header.cwd,
			file,
			writer: store.append(file),
			entries: opened.entries,
		});
	}

	/**
	 * 从一个会话分叉出新会话。
	 *
	 * 复制的是「从根到分叉点」那条路径，条目按原样写进新文件——id、时间与父子关系都不变，
	 * 两份文件因此对得上。分叉点写进新会话的头，父会话链就是这么串起来的。
	 */
	static fork(
		source: Session,
		options: {
			readonly id: string;
			readonly cwd: string;
			readonly file: string;
			readonly store: SessionStore;
			/** 分叉点；省略时取会话当前的位置 */
			readonly at?: string;
		},
	): Session {
		const at = options.at ?? source.leafId;
		if (at === null) throw new Error("This session has no entries to fork from");

		const path = pathTo(source.entries(), at);
		const forkedFrom: ForkOrigin = { session: source.id, entry: at };
		const writer = options.store.create({
			id: options.id,
			cwd: options.cwd,
			file: options.file,
			forkedFrom,
		});
		for (const entry of path) writer.write(entry);

		return new Session({
			id: options.id,
			cwd: options.cwd,
			file: options.file,
			writer,
			entries: path,
		});
	}

	get entryCount(): number {
		return this.#entries.length;
	}

	/** 当前叶子：下一个条目接在它后面。 */
	get leafId(): string | null {
		return this.#leafId;
	}

	/** 让会话文件立刻出现（只含头部），即使还没有任何条目也能被接续。 */
	begin(): void {
		if (this.#closed) throw new Error("Session is closed");
		this.#writer?.begin();
	}

	async append(entry: NewSessionEntry): Promise<void> {
		if (this.#closed) throw new Error("Session is closed");

		const id = this.#nextId();
		const complete = {
			...entry,
			id,
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
		} as SessionEntry;

		// 先落盘再改内存：写失败时状态不变，否则内存里会留下文件里没有的条目
		this.#writer?.write(complete);
		this.#entries.push(complete);
		this.#leafId = id;
		this.#folder.add(complete);
	}

	entries(): readonly SessionEntry[] {
		return this.#entries;
	}

	state(): SessionState {
		return this.#folder.state();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#writer?.end();
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
