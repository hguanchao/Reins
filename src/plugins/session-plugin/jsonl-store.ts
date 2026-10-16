import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { SessionEntry, SessionHeaderEntry } from "../../session/port.ts";
import type { SessionCreateOptions, SessionStore, SessionWriter } from "../../session/store.ts";
import { splitLines } from "../../tools/truncate.ts";
import { SessionLock } from "./lock.ts";

/**
 * 以 JSONL 保存会话。
 *
 * 每行一条记录，首行是会话头。条目之间用 id 与 parentId 串成树——即使当前只沿一条路径追加，
 * 树结构也从第一天就写进文件：事后要补分支只能改文件格式，而树的代价只是每条多一个字段。
 *
 * 文件在第一次写入时才创建，因此只是看看帮助不会留下一堆空会话。这里的职责仅限于「条目怎么
 * 落到磁盘上」：条目、折叠与叶子由宿主的会话模块负责。
 */

/** 条目格式的版本。日后若要调整字段含义，靠它决定怎么读旧文件。 */
export const SESSION_VERSION = 1;

export class JsonlSessionStore implements SessionStore {
	create(options: SessionCreateOptions): SessionWriter {
		return new JsonlWriter(options);
	}
}

class JsonlWriter implements SessionWriter {
	readonly #file: string | null;
	readonly #header: SessionHeaderEntry;
	/** 锁与文件一样，到真正要写的时候才建立：只构造不使用不该留下任何痕迹 */
	#lock: SessionLock | null = null;
	#begun = false;
	/** 首次失败的原因。写坏之后不能接着以无锁状态写下去，那等于放弃了「只有一个写入者」 */
	#failure: string | undefined;

	constructor(options: SessionCreateOptions) {
		this.#file = options.file;
		this.#header = headerOf(options.id, options.cwd);
	}

	write(entry: SessionEntry): void {
		const file = this.#file;
		if (file === null) return;
		if (this.#failure !== undefined) {
			throw new Error(`会话文件已经写入失败，不再继续写：${this.#failure}`);
		}

		try {
			this.#begin(file);
			appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
		} catch (error) {
			this.#lock?.release();
			this.#lock = null;
			this.#failure = error instanceof Error ? error.message : String(error);
			throw new Error(`写入会话文件失败：${this.#failure}`);
		}
	}

	end(): void {
		this.#lock?.release();
		this.#lock = null;
	}

	#begin(file: string): void {
		if (this.#begun) return;

		mkdirSync(dirname(file), { recursive: true });
		// 取锁要在写第一条之前：两个进程交错追加会得到两段各自完整、顺序却不是任何一方以为的历史
		this.#lock = SessionLock.acquire(file);
		// 独占创建：文件已存在说明会话标识撞上了，这种情况必须报错而不是接着写
		const handle = openSync(file, "wx");
		try {
			writeSync(handle, `${JSON.stringify(this.#header)}\n`);
		} finally {
			closeSync(handle);
		}
		this.#begun = true;
	}
}

function headerOf(id: string, cwd: string): SessionHeaderEntry {
	return {
		type: "session",
		version: SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd,
	};
}

export interface ParsedSessionFile {
	readonly header: SessionHeaderEntry | undefined;
	readonly entries: readonly SessionEntry[];
	/** 解析不了的行数。文件被外部改动过或写到一半中断过时，用它判断完整性。 */
	readonly skippedLines: number;
}

/** 解析会话文件内容。首行是会话头，其余每行一条条目。 */
export function parseSessionText(text: string): ParsedSessionFile {
	const entries: SessionEntry[] = [];
	let header: SessionHeaderEntry | undefined;
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
			header = parsed as SessionHeaderEntry;
			continue;
		}
		entries.push(parsed as SessionEntry);
	}

	return { header, entries, skippedLines };
}
