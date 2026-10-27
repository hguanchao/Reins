import type { TranscriptTool, TranscriptTurn } from "../transcript.ts";
import { showPage } from "./pages.ts";
import type { TuiHost, ViewerContent } from "./types.ts";

/**
 * Ctrl+G：把最近一块可能被折叠或截断的内容打开成整屏页。
 *
 * 对话流里的工具结果、命令详情、思考与提示保持现状；查看页只是同一份原文的完整排版。
 * 优先工具结果/详情，其次思考，最后是最近一条提示；普通 Markdown 回复本来就在对话流里，
 * 不在这里重复。
 */
export function openLatestViewer(host: TuiHost): void {
	const block = latestViewerBlock(host.state.turns);
	if (block === undefined) {
		host.setStatus("Nothing to view yet", "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	host.state.viewer = block;
	showPage(host.state, "viewer");
	host.render();
}

function latestViewerBlock(turns: readonly TranscriptTurn[]): ViewerContent | undefined {
	for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
		const turn = turns[turnIndex];
		if (turn === undefined) continue;
		for (let index = turn.response.length - 1; index >= 0; index -= 1) {
			const line = turn.response[index];
			if (typeof line === "string") continue;
			if (line.kind === "tool") {
				const block = toolBlock(line);
				if (block !== undefined) return block;
				continue;
			}
			if (line.kind === "toolGroup") {
				for (let member = line.members.length - 1; member >= 0; member -= 1) {
					const block = toolBlock(line.members[member]);
					if (block !== undefined) return block;
				}
				continue;
			}
			if (line.kind === "thinkingBlock") {
				const text =
					line.body.length === 0
						? line.partial
						: `${line.body.join("\n")}${line.partial.length === 0 ? "" : `\n${line.partial}`}`;
				if (text.trim().length > 0) return { title: "Thinking", text };
			}
		}
		if (turn.prompt.trim().length > 0) return { title: "Prompt", text: turn.prompt };
	}
	return undefined;
}

function toolBlock(tool: TranscriptTool | undefined): ViewerContent | undefined {
	if (tool === undefined) return undefined;
	// 结果才是工具实际产出的长内容；fullDetail 只用于没有结果的调用（命令全文/参数）
	if (tool.result !== undefined && tool.result.length > 0) {
		return { title: `${tool.name} output`, text: tool.result };
	}
	if (tool.fullDetail !== undefined && tool.fullDetail.length > 0) {
		return { title: `${tool.name} details`, text: tool.fullDetail };
	}
	return undefined;
}
