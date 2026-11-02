/**
 * 会话流的一行。
 *
 * 界面不逐字重建内核的复杂折叠,只保留四类行:用户、回答、思考、工具;提示与错误落为
 * notice。历史重放(会话条目)与实时事件(增量拼接)都归约到同一个形状,渲染只有一份。
 */

import type { LlmMessage, SessionEntry } from "../protocol.ts";

export type Line =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; open: boolean }
	| { kind: "thinking"; text: string; open: boolean }
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
	| { kind: "notice"; text: string; tone: "info" | "error" };

/** 会话条目重放成行;工具结果按 toolCallId 回填到对应调用行。 */
export function linesFromEntries(entries: readonly SessionEntry[]): Line[] {
	const lines: Line[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as { message: LlmMessage }).message;
		if (message.role === "user") {
			lines.push({ kind: "user", text: userText(message) });
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") lines.push({ kind: "assistant", text: block.text, open: false });
				else if (block.type === "thinking") lines.push({ kind: "thinking", text: block.text, open: false });
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
	return [...lines, { kind, text: delta, open: true } as Line];
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
