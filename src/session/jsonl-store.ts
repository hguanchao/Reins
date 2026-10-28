import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeError } from "../shared/describe-error.ts";
import { firstLine } from "../shared/format.ts";

import { SESSION_VERSION, type SessionEntry, type SessionHeaderEntry, type SessionMessageEntry } from "./port.ts";
import type {
	SessionCreateOptions,
	SessionFile,
	SessionListing,
	SessionStore,
	SessionWriter,
} from "./store.ts";
import { splitLines } from "../tools/truncate.ts";
import { SessionLock } from "./lock.ts";
import { currentPathOf } from "./tree.ts";

/**
 * 以 JSONL 保存会话。
 *
 * 每行一条记录，首行是会话头。条目之间用 id 与 parentId 串成树——即使当前只沿一条路径追加，
 * 树结构也从第一天就写进文件：事后要补分支只能改文件格式，而树的代价只是每条多一个字段。
 *
 * 文件在第一次写入时才创建，因此只是看看帮助不会留下一堆空会话。这里的职责仅限于「条目怎么
 * 落到磁盘上」：条目、折叠与叶子由宿主的会话模块负责。
 */

const FILE_SUFFIX = ".jsonl";

/**
 * 从可能残缺的用户消息里取正文。
 *
 * 会话文件是纯文本，可能被手工编辑或写到一半。取标题这一步不该因为 content 不是字符串、
 * 也不是数组就抛错——那会让整个会话列表消失。
 */
function safeUserText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { readonly content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { readonly type: string; readonly text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n\n");
}

/**
 * 清单里的标题取当前分支的第一条用户消息。
 *
 * 回退之后文件里可能留着另一条分支的开头；直接取文件里第一条会把已经离开的分支当成这个
 * 会话的主题。走不到叶子（手工改坏、成环）时退回全量条目，标题有偏差总比整份清单消失好。
 */
function currentTitle(entries: readonly SessionEntry[]): string | undefined {
	let path: readonly SessionEntry[];
	try {
		path = currentPathOf(entries);
	} catch {
		path = entries;
	}
	const userTurn = path.find(
		(entry): entry is SessionMessageEntry =>
			entry.type === "message" && entry.message.role === "user",
	);
	return userTurn === undefined ? undefined : firstLine(safeUserText(userTurn.message), 60);
}

export class JsonlSessionStore implements SessionStore {
	create(options: SessionCreateOptions): SessionWriter {
		return new JsonlWriter({ ...options, appendExisting: false });
	}

	read(file: string): SessionFile {
		const parsed = parseSessionText(readText(file));
		if (parsed.skippedLines > 0) {
			// 行坏了说明文件被改动过或写到一半断了：宁可明确拒绝，也不要读出一段缺失的历史
			throw new Error(`Session file has ${parsed.skippedLines} unparsable lines and cannot be read: ${file}`);
		}
		return { header: parsed.header, entries: parsed.entries };
	}

	append(file: string): SessionWriter {
		// 接续要在加锁前确认文件读得动：打不开或版本不对的文件不该被追加
		this.read(file);
		return new JsonlWriter({ id: "", cwd: "", file, appendExisting: true });
	}

	list(dir: string): readonly SessionListing[] {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			// 还没有人在这里工作过，就没有会话；这不是错误
			return [];
		}

		const listings: SessionListing[] = [];
		for (const name of names) {
			if (!name.endsWith(FILE_SUFFIX)) continue;
			const file = join(dir, name);
			// 单个文件读不动或内容残缺时跳过它：一个坏文件不该让整个目录的会话都列不出来，
			// 那会让 /session、/fork 与 --resume 一起失效。
			let parsed: ReturnType<typeof parseSessionText>;
			try {
				parsed = parseSessionText(readText(file));
			} catch {
				continue;
			}
			const header = parsed.header;
			const title = currentTitle(parsed.entries);
			listings.push({
				id: header?.id ?? name.slice(0, -FILE_SUFFIX.length),
				file,
				updatedAt: modifiedAt(file),
				entryCount: parsed.entries.length,
				title,
				forkedFrom: header?.forkedFrom,
			});
		}

		return listings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}
}

interface JsonlWriterOptions extends SessionCreateOptions {
	/** 接续既有文件时不写首行 */
	readonly appendExisting: boolean;
}

class JsonlWriter implements SessionWriter {
	readonly #file: string | null;
	readonly #header: SessionHeaderEntry;
	readonly #appendExisting: boolean;
	/** 锁与文件一样，到真正要写的时候才建立：只构造不使用不该留下任何痕迹 */
	#lock: SessionLock | null = null;
	#begun = false;
	/** 首次失败的原因。写坏之后不能接着以无锁状态写下去，那等于放弃了「只有一个写入者」 */
	#failure: string | undefined;

	constructor(options: JsonlWriterOptions) {
		this.#file = options.file;
		this.#appendExisting = options.appendExisting;
		this.#header = {
			type: "session",
			version: SESSION_VERSION,
			id: options.id,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			...(options.forkedFrom === undefined ? {} : { forkedFrom: options.forkedFrom }),
		};
	}

	begin(): void {
		const file = this.#file;
		if (file === null) return;
		this.#assertWritable();

		try {
			this.#begin(file);
		} catch (error) {
			this.#fail(error);
		}
	}

	write(entry: SessionEntry): void {
		const file = this.#file;
		if (file === null) return;
		this.#assertWritable();

		try {
			this.#begin(file);
			appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
		} catch (error) {
			this.#fail(error);
		}
	}

	end(): void {
		this.#lock?.release();
		this.#lock = null;
	}

	#assertWritable(): void {
		if (this.#failure !== undefined) {
			throw new Error(`The session file already failed to write; stopping: ${this.#failure}`);
		}
	}

	/** 写失败之后不能再以无锁状态接着写，否则「只有一个写入者」这个承诺就没了。 */
	#fail(error: unknown): never {
		this.#lock?.release();
		this.#lock = null;
		this.#failure = describeError(error);
		throw new Error(`Cannot write the session file: ${this.#failure}`);
	}

	#begin(file: string): void {
		if (this.#begun) return;

		mkdirSync(dirname(file), { recursive: true });
		// 取锁要在写第一条之前：两个进程交错追加会得到两段各自完整、顺序却不是任何一方以为的历史
		this.#lock = SessionLock.acquire(file);
		if (!this.#appendExisting) {
			// 独占创建：文件已存在说明会话标识撞上了，这种情况必须报错而不是接着写
			const handle = openSync(file, "wx");
			try {
				writeSync(handle, `${JSON.stringify(this.#header)}\n`);
			} finally {
				closeSync(handle);
			}
		}
		this.#begun = true;
	}
}

interface ParsedSessionFile {
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
		const record = parsed as Record<string, unknown>;
		if (record["type"] === "session") {
			// 会话头至少要有 id 与版本:续聊按 id 找文件,版本对不上时 open 会拒绝读取
			if (typeof record["id"] !== "string" || typeof record["version"] !== "number") {
				skippedLines += 1;
				continue;
			}
			header = parsed as SessionHeaderEntry;
			continue;
		}
		if (!isEntryType(record["type"]) || !entryLooksIntact(record)) {
			// 认得条目才敢往下走：不认识的类型多半是更高版本写的，猜着读只会读出一段错的历史;
			// 认得但关键字段残缺的同样拒收,否则坏形状会在回放消费点炸成运行时错误
			skippedLines += 1;
			continue;
		}
		entries.push(parsed as SessionEntry);
	}

	return { header, entries, skippedLines };
}

/**
 * 条目关键字段的最小校验:只查回放路径真正会读的字段,不做完整形状断言。
 *
 * 会话文件是磁盘上的外部输入,外部改动与写盘中断都会留下残缺行;校验失败与解析失败
 * 同一待遇(计入 skippedLines),宁可少读一行,不读一段会炸的历史。
 */
function entryLooksIntact(parsed: Record<string, unknown>): boolean {
	switch (parsed["type"]) {
		case "message": {
			const message = parsed["message"];
			if (typeof message !== "object" || message === null) return false;
			const record = message as Record<string, unknown>;
			const role = record["role"];
			if (role === "toolResult") {
				return (
					typeof record["toolCallId"] === "string" &&
					typeof record["toolName"] === "string" &&
					typeof record["content"] === "string"
				);
			}
			// user 与 assistant 的 content 可以是字符串或内容块数组,这里只验它存在
			return (role === "user" || role === "assistant") && record["content"] !== undefined;
		}
		case "system":
			return typeof parsed["sections"] === "object" && parsed["sections"] !== null;
		case "model_change":
			return typeof parsed["model"] === "string";
		case "effort_change":
			return typeof parsed["effort"] === "string";
		case "branch":
			return parsed["reason"] === "rewind" || parsed["reason"] === "switch";
		case "usage":
			return (
				typeof parsed["model"] === "string" &&
				typeof parsed["usage"] === "object" &&
				parsed["usage"] !== null
			);
		case "compaction":
			return typeof parsed["summary"] === "string" && Array.isArray(parsed["covered"]);
		default:
			return false;
	}
}

function isEntryType(type: unknown): boolean {
	return (
		type === "message" ||
		type === "system" ||
		type === "model_change" ||
		type === "effort_change" ||
		type === "branch" ||
		type === "usage" ||
		type === "compaction"
	);
}

function readText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`Cannot read the session file: ${describeError(error)}`);
	}
}

function modifiedAt(file: string): string {
	try {
		return statSync(file).mtime.toISOString();
	} catch {
		return new Date(0).toISOString();
	}
}

