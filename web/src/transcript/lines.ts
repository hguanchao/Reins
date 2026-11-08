/**
 * 会话流的一行。
 *
 * 界面不逐字重建内核的复杂折叠,只保留四类行:用户、回答、思考、工具;提示与错误落为
 * notice。历史重放(会话条目)与实时事件(增量拼接)都归约到同一个形状,渲染只有一份。
 */

import type { ApprovalAnswer, ApprovalRequest, LlmMessage, SessionEntry } from "../protocol.ts";

export type Line =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; open: boolean }
	| {
			kind: "thinking";
			text: string;
			open: boolean;
			/** 流式思考的起表时刻：封口时据此算出耗时；历史重放没有它，直接带 durationMs */
			startedAt?: number;
			/** 本段思考的耗时（毫秒）；思考折叠行的「N 秒」读数 */
			durationMs?: number;
	  }
	| {
			kind: "tool";
			callId: string;
			name: string;
			args: Record<string, unknown> | undefined;
			running: boolean;
			isError: boolean;
			durationMs: number | undefined;
			summary: string | undefined;
			detail: string;
			content: string | undefined;
			details: unknown;
	  }
	| { kind: "notice"; text: string; tone: "info" | "error" }
	/** 已裁决的审批记录：与 notice 同生命周期，只伴随当前会话，内核尚未持久化裁决 */
	| { kind: "gate"; request: ApprovalRequest; answer: ApprovalAnswer; at: string };

/** 会话条目重放成行;工具结果按 toolCallId 回填到对应调用行。 */
export function linesFromEntries(entries: readonly SessionEntry[]): Line[] {
	const lines: Line[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const record = entry as { message: LlmMessage; thinkingMs?: readonly number[] };
		const message = record.message;
		if (message.role === "user") {
			lines.push({ kind: "user", text: userText(message) });
		} else if (message.role === "assistant") {
			// 思考条目按内容顺序带各自的耗时,数到第几段就取第几个
			let thinkingIndex = 0;
			for (const block of message.content) {
				if (block.type === "text") lines.push({ kind: "assistant", text: block.text, open: false });
				else if (block.type === "thinking") {
					const durationMs = record.thinkingMs?.[thinkingIndex];
					thinkingIndex += 1;
					lines.push({
						kind: "thinking",
						text: block.text,
						open: false,
						...(durationMs === undefined ? {} : { durationMs }),
					});
				}
				// 调用行先占位,紧跟的 toolResult 条目按 toolCallId 回填结论
				else if (block.type === "toolCall") {
					lines.push({
						kind: "tool",
						callId: block.id,
						name: block.name,
						args: block.arguments,
						running: false,
						isError: false,
						durationMs: undefined,
						summary: undefined,
						detail: "",
						content: undefined,
						details: undefined,
					});
				}
			}
		} else {
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const line = lines[index];
				if (line.kind === "tool" && line.callId === message.toolCallId) {
					lines[index] = {
						...line,
						running: false,
						isError: message.isError,
						summary: firstLine(message.content),
						content: message.content,
					};
					break;
				}
			}
		}
	}
	return lines;
}

function userText(message: Extract<LlmMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((block) => (block.type === "text" ? block.text : `[image: ${block.name ?? "unnamed"}]`))
		.join("\n");
}

function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	return newline === -1 ? text : text.slice(0, newline);
}

/** 拼增量:只并进同 kind 的最后一行,且那行还开着(新回合不会接上上一回合的尾巴)。 */
export function appendToLast(lines: readonly Line[], kind: "assistant" | "thinking", delta: string): Line[] {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line.kind !== kind) continue;
		if (!line.open) break;
		const next = lines.slice();
		next[index] = { ...line, text: line.text + delta };
		return next;
	}
	// 思考段起表:流式期间没有条目时间戳,耗时只能在封口时用起表时刻现算
	if (kind === "thinking") {
		return [...lines, { kind, text: delta, open: true, startedAt: Date.now() } as Line];
	}
	return [...lines, { kind, text: delta, open: true } as Line];
}

/**
 * 封口打开着的思考段并记下耗时:「思考了 N 秒」的秒数只在思考结束的那一刻才知道。
 * 正文增量、工具调用、回合结束都会终结思考,调用方在各自的事件里先走这一步。
 */
export function sealThinking(lines: readonly Line[], now: number): readonly Line[] {
	let changed = false;
	const next = lines.map((line) => {
		if (line.kind !== "thinking" || !line.open) return line;
		changed = true;
		const durationMs = line.startedAt === undefined ? undefined : Math.max(0, now - line.startedAt);
		return {
			...line,
			open: false,
			...(durationMs === undefined ? {} : { durationMs }),
		};
	});
	return changed ? next : lines;
}

/** 结束当前回合的流式行:之后的新回答另起一行。 */
export function sealStreaming(lines: readonly Line[]): Line[] {
	return lines.map((line) =>
		line.kind === "assistant" || line.kind === "thinking" ? { ...line, open: false } : line,
	);
}

/** 按调用标识找工具行并改写;返回 false 表示没找到(调用方不关心,丢弃即可)。 */
export function updateTool(
	lines: readonly Line[],
	callId: string,
	patch: (line: Extract<Line, { kind: "tool" }>) => Line,
): Line[] {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line.kind === "tool" && line.callId === callId) {
			const next = lines.slice();
			next[index] = patch(line);
			return next;
		}
	}
	return lines as Line[];
}

/** 一次工具调用的行。 */
export type ToolLine = Extract<Line, { kind: "tool" }>;

/** 会话流的分块:连续的几次工具调用并成一块,渲染时连成一条轨迹。 */
export type LineBlock = { kind: "line"; line: Line } | { kind: "tools"; items: readonly ToolLine[] };

/**
 * 把连续的工具行并成块。
 *
 * 一次任务里工具调用往往连着出现七八行,逐行平铺会把回答推得很远;并块之后只看得到
 * 一条轨迹,展开某一项仍然能看到它的输出。
 */
export function groupToolRuns(lines: readonly Line[]): LineBlock[] {
	const blocks: LineBlock[] = [];
	for (const line of lines) {
		if (line.kind !== "tool") {
			blocks.push({ kind: "line", line });
			continue;
		}
		const last = blocks[blocks.length - 1];
		if (last !== undefined && last.kind === "tools") {
			blocks[blocks.length - 1] = { kind: "tools", items: [...last.items, line] };
		} else {
			blocks.push({ kind: "tools", items: [line] });
		}
	}
	return blocks;
}
