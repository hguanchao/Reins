/**
 * 会话流的分块。
 *
 * 界面按「回合」组织：一次提问与它后面的回答算一轮，轮内再把连续的工具调用并入工具块。
 * 这里只做纯计算，渲染层拿到的已经是可直接铺排的结构。
 */

import type { Line, ToolLine } from "./lines.ts";

/** 工具动作的分流：读取类折叠一行，写入类内联 diff。 */
export type ToolAction = "read" | "search" | "list" | "write" | "run" | "skill" | "mcp" | "other";

const WRITE_TOOLS = new Set(["write", "edit", "patch"]);

export function toolAction(name: string): ToolAction {
	if (WRITE_TOOLS.has(name)) return "write";
	if (name === "read") return "read";
	if (name === "grep" || name === "find") return "search";
	if (name === "ls") return "list";
	if (name === "bash" || name === "pwsh") return "run";
	if (name.startsWith("mcp__")) return "mcp";
	if (name === "skill") return "skill";
	return "other";
}

/** 连续同类调用可以并成一组摘要；写入与运行各自独立成行，不参与并组。 */
export function groupable(name: string): boolean {
	const action = toolAction(name);
	return action === "read" || action === "search" || action === "list";
}

export interface ToolGroup {
	readonly kind: "group";
	readonly items: readonly ToolLine[];
	readonly reads: number;
	readonly searches: number;
	readonly lists: number;
}

export type ToolBlock = { readonly kind: "single"; readonly line: ToolLine } | ToolGroup;

/** 把一段连续工具行切成「可并组的读取类」与「单独成行的写入/运行」。 */
export function splitToolRun(items: readonly ToolLine[]): readonly ToolBlock[] {
	const blocks: ToolBlock[] = [];
	let bucket: ToolLine[] = [];

	const flush = (): void => {
		if (bucket.length === 0) return;
		if (bucket.length === 1) {
			const only = bucket[0];
			if (only !== undefined) blocks.push({ kind: "single", line: only });
			bucket = [];
			return;
		}
		let reads = 0;
		let searches = 0;
		let lists = 0;
		for (const item of bucket) {
			const action = toolAction(item.name);
			if (action === "read") reads += 1;
			else if (action === "search") searches += 1;
			else lists += 1;
		}
		blocks.push({ kind: "group", items: bucket, reads, searches, lists });
		bucket = [];
	};

	for (const item of items) {
		if (groupable(item.name)) {
			bucket.push(item);
			continue;
		}
		flush();
		blocks.push({ kind: "single", line: item });
	}
	flush();
	return blocks;
}

export interface Turn {
	/** 轮次序号，从 1 起；没有提问的回合（恢复出来的旧流）也算一轮 */
	readonly index: number;
	readonly ask: Extract<Line, { kind: "user" }> | undefined;
	readonly lines: readonly Line[];
}

/**
 * 按提问切回合。
 *
 * 提问之前的零散行（例如恢复出来的第一条回答）归入第一个回合；没有提问的整段流也算一轮，
 * 这样「回到最新」与消息轨的下标始终对得上。
 */
export function groupTurns(lines: readonly Line[]): readonly Turn[] {
	const turns: Turn[] = [];
	let current: Line[] = [];
	let ask: Extract<Line, { kind: "user" }> | undefined;

	const push = (): void => {
		if (ask === undefined && current.length === 0) return;
		turns.push({ index: turns.length + 1, ask, lines: current });
		current = [];
		ask = undefined;
	};

	for (const line of lines) {
		if (line.kind === "user") {
			push();
			ask = line;
			current = [];
			continue;
		}
		current.push(line);
	}
	push();
	return turns;
}

/** 「轮 · 步」读数里的轮数。 */
export function turnCount(lines: readonly Line[]): number {
	return lines.reduce((count, line) => (line.kind === "user" ? count + 1 : count), 0);
}
