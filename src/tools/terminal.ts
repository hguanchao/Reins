import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { describeError } from "../shared/describe-error.ts";
import { formatDuration } from "../shared/format.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionReadView } from "../session/port.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import type { AnyToolDefinition, PermissionScope, ToolDefinition, ToolResult } from "./contract.ts";
import type { JsonSchema } from "./schema.ts";
import { commandScope } from "./builtin/bash.ts";
import { killProcessTree, resolveShell, sanitizeOutput } from "./shell.ts";
import { DEFAULT_LIMITS, truncateTail } from "./truncate.ts";

/**
 * 持久终端。
 *
 * 与 bash 的一次性进程不同，这里的进程跨工具调用存活，stdin 一直开着：模型可以启动一个
 * REPL 或 dev server，再逐条写输入、分段读输出。实现走管道而不是 PTY——真正的 PTY 需要
 * 原生依赖，而宿主坚持无构建产物、开箱可用；代价是全屏 TUI 程序（vim、top 之类）不能运行，
 * 工具说明里写明了这一点。REPL、测试监听、dev server 这类只需要 stdin 的场景不受影响。
 *
 * 终端只活在当前进程里：退出时统一终止，不做跨进程恢复。输出由环形缓冲保存，模型按
 * 「上次读到哪里」增量读取，缓冲满时丢掉最旧的部分并明确告知。
 */

export type TerminalStatus = "running" | "exited" | "killed";

export interface TerminalView {
	readonly id: string;
	readonly command: string;
	readonly status: TerminalStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly sessionId: string;
}

interface TerminalRead {
	readonly view: TerminalView;
	/** 上次读取之后的新输出；all 为 true 时是整段保留缓冲 */
	readonly output: string;
	/** 缓冲满之后丢过最旧的输出 */
	readonly dropped: boolean;
}

export interface TerminalStartInput {
	readonly command: string;
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly session: SessionReadView;
}

interface TerminalManagerOptions {
	readonly shellPath?: string;
}

/** 单个终端保留的输出字符数；超出后从最旧的一端丢弃。 */
const MAX_TERMINAL_CHARS = 1_000_000;
/** 同时运行的终端上限：每个都是一整个进程树，不设上限等于把资源交给模型随意消耗。 */
const MAX_ACTIVE_TERMINALS = 8;
/** 已结束终端保留的条数；运行中的永远保留。 */
const COMPLETED_LIMIT = 20;
const DEFAULT_WAIT_MS = 250;
const MAX_WAIT_MS = 5_000;

interface TerminalSession {
	info: TerminalView;
	readonly child: ChildProcess;
	readonly output: TerminalBuffer;
	readonly waiters: Set<() => void>;
	exited: boolean;
	killRequested: boolean;
	readonly done: Promise<void>;
	resolveDone: () => void;
}

/**
 * 增量输出缓冲。
 *
 * 读位置按字符计；从前面丢数据时同步前移，否则下一次读取会把「已经读过的内容」当成新的。
 */
class TerminalBuffer {
	readonly #chunks: string[] = [];
	#length = 0;
	#readOffset = 0;
	#dropped = false;

	append(text: string): void {
		if (text.length === 0) return;
		this.#chunks.push(text);
		this.#length += text.length;

		while (this.#length > MAX_TERMINAL_CHARS) {
			const first = this.#chunks[0];
			if (first === undefined) break;
			const excess = this.#length - MAX_TERMINAL_CHARS;
			if (first.length <= excess) {
				this.#chunks.shift();
				this.#length -= first.length;
				this.#readOffset = Math.max(0, this.#readOffset - first.length);
			} else {
				this.#chunks[0] = first.slice(excess);
				this.#length -= excess;
				this.#readOffset = Math.max(0, this.#readOffset - excess);
			}
			this.#dropped = true;
		}
	}

	hasUnread(): boolean {
		return this.#length > this.#readOffset;
	}

	read(all: boolean): { readonly text: string; readonly dropped: boolean } {
		if (all) this.#readOffset = 0;
		const full = this.#chunks.join("");
		const text = full.slice(this.#readOffset);
		this.#readOffset = full.length;
		const dropped = this.#dropped;
		this.#dropped = false;
		return { text, dropped };
	}
}

export class TerminalManager {
	readonly #shellPath: string | undefined;
	readonly #terminals = new Map<string, TerminalSession>();
	#next = 0;

	constructor(options: TerminalManagerOptions = {}) {
		this.#shellPath = options.shellPath;
	}

	/** 启动一个持久进程；shell 选择失败直接抛错。 */
	start(input: TerminalStartInput): TerminalView {
		const active = [...this.#terminals.values()].filter((session) => session.info.status === "running");
		if (active.length >= MAX_ACTIVE_TERMINALS) {
			throw new Error(
				`Too many running terminals (${MAX_ACTIVE_TERMINALS}); kill one with terminal_kill before starting another.`,
			);
		}

		const shell = resolveShell(undefined, this.#shellPath);
		const child = spawn(shell.command, shell.args(input.sandbox.wrapCommand(input.command)), {
			cwd: input.workspace.root,
			env: {
				...shell.env,
				...process.env,
				REINS_SESSION_ID: input.session.id,
				...(input.session.path === null ? {} : { REINS_SESSION_FILE: input.session.path }),
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});

		const id = `t${++this.#next}`;
		let resolveDone = (): void => {};
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const session: TerminalSession = {
			info: {
				id,
				command: input.command,
				status: "running",
				startedAt: Date.now(),
				sessionId: input.session.id,
			},
			child,
			output: new TerminalBuffer(),
			waiters: new Set(),
			exited: false,
			killRequested: false,
			done,
			resolveDone,
		};
		this.#terminals.set(id, session);
		this.#prune();

		const stdout = new StringDecoder("utf8");
		const stderr = new StringDecoder("utf8");
		child.stdout?.on("data", (chunk: Buffer) => this.#append(session, stdout.write(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => this.#append(session, stderr.write(chunk)));
		// 进程退出后再写 stdin 会得到 EPIPE；不消费这个事件会让整个进程收到未捕获异常
		child.stdin?.on("error", () => undefined);

		child.on("error", (error) => {
			if (session.exited) return;
			session.exited = true;
			session.info = {
				...session.info,
				status: "exited",
				endedAt: Date.now(),
				exitCode: null,
				signal: null,
			};
			this.#append(session, `\n[failed to start: ${error.message}]\n`);
			session.resolveDone();
			this.#notify(session);
		});

		child.on("close", (code, signal) => {
			if (session.exited) return;
			session.exited = true;
			session.info = {
				...session.info,
				status: session.killRequested ? "killed" : "exited",
				endedAt: Date.now(),
				exitCode: code,
				signal: signal ?? null,
			};
			const flush = stdout.end() + stderr.end();
			if (flush.length > 0) this.#append(session, flush);
			session.resolveDone();
			this.#notify(session);
			this.#prune();
		});

		return session.info;
	}

	/**
	 * 写入 stdin 并等待输出。
	 *
	 * 进程已经退出时不再写，直接返回当前状态；submit 为 true 时补一个换行，已有换行则不重复补。
	 */
	async write(
		id: string,
		input: string,
		submit: boolean,
		waitMs: number,
	): Promise<TerminalRead | undefined> {
		const session = this.#terminals.get(id);
		if (session === undefined) return undefined;

		if (session.info.status === "running" && !session.exited) {
			const payload = submit && !input.endsWith("\n") ? `${input}\n` : input;
			try {
				session.child.stdin?.write(payload, "utf8");
			} catch (error) {
				this.#append(session, `\n[failed to write to stdin: ${describeError(error)}]\n`);
			}
			await waitForOutput(session, waitMs);
		}
		return this.#read(session, false);
	}

	/** 读取新输出；all 为 true 时返回整段保留缓冲且不等待。 */
	async read(id: string, waitMs: number, all: boolean): Promise<TerminalRead | undefined> {
		const session = this.#terminals.get(id);
		if (session === undefined) return undefined;
		if (!all) await waitForOutput(session, waitMs);
		return this.#read(session, all);
	}

	/** 终止终端；短暂等待退出，让返回状态尽量是最终状态。 */
	async kill(id: string, waitMs = 500): Promise<TerminalView | undefined> {
		const session = this.#terminals.get(id);
		if (session === undefined) return undefined;
		if (session.info.status === "running" && !session.exited) {
			session.killRequested = true;
			killProcessTree(session.child);
			await Promise.race([session.done, delay(waitMs)]);
		}
		return session.info;
	}

	/** 退出时收起所有子进程，避免留下孤儿进程。 */
	shutdown(): void {
		for (const session of this.#terminals.values()) {
			if (session.info.status !== "running" || session.exited) continue;
			session.killRequested = true;
			killProcessTree(session.child);
		}
	}

	#read(session: TerminalSession, all: boolean): TerminalRead {
		const result = session.output.read(all);
		return { view: session.info, output: result.text, dropped: result.dropped };
	}

	#append(session: TerminalSession, raw: string): void {
		const text = sanitizeOutput(raw);
		if (text.length === 0) return;
		session.output.append(text);
		this.#notify(session);
	}

	#notify(session: TerminalSession): void {
		for (const waiter of session.waiters) waiter();
	}

	#prune(): void {
		const finished = [...this.#terminals.values()]
			.filter((session) => session.info.status !== "running")
			.sort((left, right) => (right.info.endedAt ?? 0) - (left.info.endedAt ?? 0));
		for (const session of finished.slice(COMPLETED_LIMIT)) {
			this.#terminals.delete(session.info.id);
		}
	}
}

/** 等到有新输出、进程退出或超时；没有新输出时超时本身不是错误。 */
function waitForOutput(session: TerminalSession, waitMs: number): Promise<void> {
	if (session.output.hasUnread() || session.exited) return Promise.resolve();
	const timeout = Math.min(Math.max(0, waitMs), MAX_WAIT_MS);
	if (timeout === 0) return Promise.resolve();

	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			session.waiters.delete(finish);
			resolve();
		};
		session.waiters.add(finish);
		timer = setTimeout(finish, timeout);
		timer.unref?.();
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		timer.unref?.();
	});
}

function outputBody(output: string, dropped: boolean): string {
	const parts: string[] = [];
	if (dropped) parts.push("[earlier output was dropped after the buffer filled]");
	if (output.length === 0) {
		parts.push("[no new output]");
		return parts.join("\n");
	}
	const truncated = truncateTail(output, DEFAULT_LIMITS);
	if (truncated.truncated) parts.push(`[showing the end of the output, ${truncated.totalLines} lines total]`);
	parts.push(truncated.text);
	return parts.join("\n");
}

function formatRead(read: TerminalRead): string {
	const view = read.view;
	const elapsed = (view.endedAt ?? Date.now()) - view.startedAt;
	const notes: string[] = [];
	if (view.status === "exited" && view.exitCode !== undefined && view.exitCode !== null) {
		notes.push(`[exit code ${view.exitCode}]`);
	}
	if (view.signal !== undefined && view.signal !== null) notes.push(`[killed by ${view.signal}]`);
	return [
		`Terminal ${view.id} · ${view.status} · ${formatDuration(elapsed)} · ${view.command}`,
		...notes,
		"",
		outputBody(read.output, read.dropped),
	].join("\n");
}

const START_PARAMETERS = {
	type: "object",
	properties: {
		command: {
			type: "string",
			description: "Command to run and keep alive. It starts in the workspace root.",
		},
		waitMs: {
			type: "integer",
			minimum: 0,
			description: "How long to wait for initial output, up to 5000 ms; default 250.",
		},
	},
	required: ["command"],
} as const satisfies JsonSchema;

type TerminalStartArgs = {
	readonly command: string;
	readonly waitMs?: number;
};

const WRITE_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "The terminal id returned by terminal_start." },
		input: {
			type: "string",
			description: "Text to send to the process's stdin. Omit it (or pass an empty string) to only read new output.",
		},
		submit: {
			type: "boolean",
			description: "Append a newline when the input does not already end with one. Default true.",
		},
		waitMs: {
			type: "integer",
			minimum: 0,
			description: "How long to wait for output, up to 5000 ms; default 250.",
		},
	},
	required: ["id"],
} as const satisfies JsonSchema;

type TerminalWriteArgs = {
	readonly id: string;
	readonly input?: string;
	readonly submit?: boolean;
	readonly waitMs?: number;
};

const ID_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "The terminal id returned by terminal_start." },
	},
	required: ["id"],
} as const satisfies JsonSchema;

type TerminalIdArgs = {
	readonly id: string;
};

/** 持久终端相关的全部工具；没有终端管理器时整组不注册。 */
export function createTerminalTools(manager: TerminalManager): readonly AnyToolDefinition[] {
	const start: ToolDefinition<TerminalStartArgs> = {
		name: "terminal_start",
		summary: "Start a long-running process and keep its stdin open",
		description:
			"Start a long-running process and keep its stdin open across tool calls. Use it for REPLs, dev servers, " +
			"test watchers and similar interactive work. This is a pipe-backed terminal, not a full PTY: programs " +
			"that require a real terminal (full-screen editors, curses UIs) will not work. Use bash for one-shot " +
			"commands. Output is accumulated per terminal; read it with terminal_write (omit input) or send input " +
			"with terminal_write.",
		parameters: START_PARAMETERS,
		annotations: { readOnly: false, destructive: true, openWorld: true },

		permissionScope: (args): PermissionScope | undefined => commandScope(args.command),

		async execute({ args, workspace, sandbox, session }): Promise<ToolResult> {
			let view: TerminalView;
			try {
				view = manager.start({ command: args.command, workspace, sandbox, session });
			} catch (error) {
				return { content: `Failed to start terminal: ${describeError(error)}`, isError: true };
			}

			const read = await manager.read(view.id, args.waitMs ?? DEFAULT_WAIT_MS, false);
			const exited = read !== undefined && read.view.status !== "running";
			// 启动失败时 exitCode 与 signal 都是 null；正常退出至少会有一个
			const failed =
				read !== undefined &&
				read.view.status === "exited" &&
				((read.view.exitCode !== undefined &&
					read.view.exitCode !== null &&
					read.view.exitCode !== 0) ||
					(read.view.exitCode === null && read.view.signal === null));
			return {
				content: [
					exited
						? `Terminal ${view.id} exited before input: ${args.command}`
						: `Started terminal ${view.id}: ${args.command}`,
					...(read === undefined ? [] : [formatRead(read)]),
					`Use terminal_write with id "${view.id}" to send input or read output, terminal_kill to stop.`,
				].join("\n\n"),
				...(failed ? { isError: true } : {}),
				details: { terminalId: view.id, status: read?.view.status ?? view.status },
			};
		},
	};

	const write: ToolDefinition<TerminalWriteArgs> = {
		name: "terminal_write",
		summary: "Send input to a running terminal and return new output",
		description:
			"Send text to a terminal's stdin and return output produced since the last read. Omit input (or pass an " +
			"empty string) to only read new output. submit defaults to true and appends a newline when the input does " +
			"not already end with one. A terminal that already exited is not written to; its final status is returned.",
		parameters: WRITE_PARAMETERS,
		annotations: { readOnly: false, destructive: true, openWorld: true },

		permissionScope: (args): PermissionScope => ({
			key: args.id,
			label: `terminal ${args.id}`,
			short: args.id,
		}),

		async execute({ args }): Promise<ToolResult> {
			const waitMs = args.waitMs ?? DEFAULT_WAIT_MS;
			const hasInput = args.input !== undefined && args.input.length > 0;
			const read = hasInput
				? await manager.write(args.id, args.input ?? "", args.submit ?? true, waitMs)
				: await manager.read(args.id, waitMs, false);
			if (read === undefined) {
				return { content: `Unknown terminal: ${args.id}`, isError: true };
			}
			const stopped =
				hasInput && read.view.status !== "running"
					? `Terminal ${read.view.id} is ${read.view.status}; input was not sent.\n\n`
					: "";
			return {
				content: `${stopped}${formatRead(read)}`,
				details: { terminalId: args.id, status: read.view.status },
			};
		},
	};

	const kill: ToolDefinition<TerminalIdArgs> = {
		name: "terminal_kill",
		summary: "Stop a terminal and its child processes",
		description: "Stop a terminal started with terminal_start. Its process tree is terminated; finished terminals are left alone.",
		parameters: ID_PARAMETERS,
		annotations: { readOnly: false, destructive: true, openWorld: false },

		permissionScope: (args): PermissionScope => ({
			key: args.id,
			label: `terminal ${args.id}`,
			short: args.id,
		}),

		async execute({ args }): Promise<ToolResult> {
			const view = await manager.kill(args.id);
			if (view === undefined) {
				return { content: `Unknown terminal: ${args.id}`, isError: true };
			}
			return {
				content:
					view.status === "running"
						? `Stopping terminal ${view.id}: ${view.command}`
						: `Terminal ${view.id} is already ${view.status}.`,
				details: { terminalId: view.id, status: view.status },
			};
		},
	};

	return [start, write, kill];
}
