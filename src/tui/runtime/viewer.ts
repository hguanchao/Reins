import type { TranscriptTool, TranscriptTurn } from "#src/tui/transcript.ts";
import { showPage } from "#src/tui/runtime/pages.ts";
import { STATUS, VIEWER_TITLE, toolDetailsTitle, toolOutputTitle } from "#src/tui/copy.ts";
import type { TuiHost, ViewerContent } from "#src/tui/runtime/types.ts";

/**
 * Ctrl+G：把使用者选中的工具或最近一块可能被折叠/截断的内容打开成整屏页。
 *
 * 点选或展开过的工具优先，Ctrl+G 跟着使用者正在看的那一行；没有这种选择时才回退到
 * 对话流里最近的长内容。查看页只是同一份原文的完整排版，不改变对话流本身。
 */
export function openLatestViewer(host: TuiHost): void {
	const block =
		(host.state.viewerTool === undefined ? undefined : anchoredBlock(host.state.viewerTool)) ??
		latestViewerBlock(host.state.turns);
	if (block === undefined) {
		host.setStatus(STATUS.nothingToView, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	host.state.viewer = block;
	showPage(host.state, "viewer");
	host.render();
}

/** 目标工具的内容；连结果和详情都没有时退回它的一行说明，别让 Ctrl+G 跳去看别处。 */
function anchoredBlock(tool: TranscriptTool): ViewerContent | undefined {
	const block = toolBlock(tool);
	if (block !== undefined) return block;
	return tool.detail.length === 0 ? undefined : { title: `${tool.name} details`, text: tool.detail };
}

/** 回退路径：优先工具结果/详情，其次思考，最后是最近一条提示；普通回复本来就在对话流里。 */
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
				if (text.trim().length > 0) return { title: VIEWER_TITLE.thinking, text };
			}
		}
		if (turn.prompt.trim().length > 0) return { title: VIEWER_TITLE.prompt, text: turn.prompt };
	}
	return undefined;
}

function toolBlock(tool: TranscriptTool | undefined): ViewerContent | undefined {
	if (tool === undefined) return undefined;
	// 结果才是工具实际产出的长内容；fullDetail 只用于没有结果的调用（命令全文/参数）
	if (tool.result !== undefined && tool.result.length > 0) {
		return { title: toolOutputTitle(tool.name), text: tool.result };
	}
	if (tool.fullDetail !== undefined && tool.fullDetail.length > 0) {
		return { title: toolDetailsTitle(tool.name), text: tool.fullDetail };
	}
	return undefined;
}
