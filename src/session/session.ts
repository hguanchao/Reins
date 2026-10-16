import { randomBytes } from "node:crypto";

import { SessionFolder } from "./fold.ts";
import type { NewSessionEntry, SessionEntry, SessionPort, SessionState } from "./port.ts";
import type { SessionWriter } from "./store.ts";

/**
 * 会话。
 *
 * 条目用 id/parentId 串成树，写入时只沿当前叶子追加，文件里因此天然是一条路径。落盘交给
 * 写入器：会话本身只负责条目、叶子与折叠出的状态，所以同一套语义既能写进 JSONL，也能只留在
 * 内存里。
 */

export interface SessionOptions {
	readonly id: string;
	readonly cwd: string;
	/** 落盘位置；null 表示只在内存里 */
	readonly file: string | null;
	/** 落盘通道。file 非 null 时必须给：没有通道就写不下去，这件事必须在构造时暴露 */
	readonly writer?: SessionWriter;
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
			throw new Error("把会话写到文件需要会话存储");
		}
		this.id = options.id;
		this.cwd = options.cwd;
		this.path = options.file;
		this.#writer = options.writer;
	}

	get entryCount(): number {
		return this.#entries.length;
	}

	/** 当前叶子：下一个条目接在它后面。 */
	get leafId(): string | null {
		return this.#leafId;
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
