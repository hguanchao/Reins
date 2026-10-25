import assert from "node:assert/strict";
import type { TranscriptTodo } from "../../../src/tui/todo-card.ts";
import { describe, it } from "node:test";

import { buildTranscriptView, renderTranscript, todoHeaderInView, toggleLastExpandable } from "../../../src/tui/transcript.ts";
import type { TranscriptTurn } from "../../../src/tui/transcript.ts";


function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("收尾任务卡", () => {
	const card: TranscriptTodo = {
		kind: "todo",
		items: [
			{ content: "写工具", status: "completed" },
			{ content: "修路径", status: "failed" },
		],
	};

	it("头行汇总状态计数,清单带 TaskN 标签;头行可以命中", () => {
		const view = buildTranscriptView(80, [{ prompt: "go", response: [card] }], undefined);
		const text = view.lines.map(plain).join("\n");

		assert.ok(text.includes("› Tasks  1 done · 1 failed"));
		assert.ok(text.includes("● Task1  写工具"));
		assert.ok(text.includes("× Task2  修路径"));
		assert.equal(view.todoHeaders.length, 1);

		const row = (view.todoHeaders[0]?.start ?? 0) + 1;
		assert.equal(todoHeaderInView(view, 20, 0, row), card);
		// 条目行不参与头行命中
		assert.equal(todoHeaderInView(view, 20, 0, row + 1), undefined);
	});

	it("收起后只渲染头行,Ctrl+E 可以再展开", () => {
		const collapsed: TranscriptTodo = { ...card, collapsed: true };
		const turns: TranscriptTurn[] = [{ prompt: "go", response: [collapsed] }];
		const text = renderTranscript(80, 12, turns, 0).map(plain).join("\n");

		assert.ok(text.includes("› Tasks  1 done · 1 failed"));
		assert.equal(text.includes("Task1"), false);

		assert.equal(toggleLastExpandable(turns), true);
		assert.equal(collapsed.collapsed, false);
		assert.ok(renderTranscript(80, 12, turns, 0).map(plain).join("\n").includes("● Task1  写工具"));
	});
});
