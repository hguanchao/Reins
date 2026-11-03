import type { Line } from "../transcript/lines.ts";

/** 轨迹页的一轮：输入、最后一段回答、工具调用数与累计耗时。 */
export interface TrajectoryTurn {
	readonly turn: number;
	readonly user: string;
	readonly assistant: string;
	readonly toolCount: number;
	readonly failedTools: number;
	readonly durationMs: number;
}

function firstLine(text: string): string {
	const normalized = text.replaceAll("\r\n", "\n").trim();
	const newline = normalized.indexOf("\n");
	return newline === -1 ? normalized : normalized.slice(0, newline);
}

/** 把会话流按用户消息切成轮次；工具耗时求和，失败调用单独计数。 */
export function summarizeTurns(lines: readonly Line[]): readonly TrajectoryTurn[] {
	const turns: {
		turn: number;
		user: string;
		assistant: string;
		toolCount: number;
		failedTools: number;
		durationMs: number;
	}[] = [];
	let current: (typeof turns)[number] | undefined;

	const start = (user: string): (typeof turns)[number] => {
		const next = {
			turn: turns.length + 1,
			user,
			assistant: "",
			toolCount: 0,
			failedTools: 0,
			durationMs: 0,
		};
		turns.push(next);
		return next;
	};

	for (const line of lines) {
		if (line.kind === "user") {
			current = start(firstLine(line.text));
			continue;
		}
		if (current === undefined) current = start("");
		if (line.kind === "assistant") {
			const text = firstLine(line.text);
			if (text.length > 0) current.assistant = text;
		} else if (line.kind === "tool") {
			current.toolCount += 1;
			if (line.isError) current.failedTools += 1;
			current.durationMs += line.durationMs ?? 0;
		}
	}
	return turns;
}
