import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	todoCardFinished,
	todoCardFromArgs,
	todoCardLines,
	todoPanelLines,
	TODO_PANEL_MAX_ITEMS,
	type TranscriptTodo,
} from "../../../src/tui/view/todo-card.ts";
import { displayWidth } from "../../../src/tui/render/text.ts";
import { THEME } from "../../../src/tui/render/theme.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;:]*m/g, "");
}

const FRAME = { spinner: "⠋", sweepPhase: 0.5 };

describe("任务面板", () => {
	const card: TranscriptTodo = {
		kind: "todo",
		explanation: "调整:先做渲染",
		running: true,
		items: [
			{ content: "写工具", status: "completed" },
			{ content: "渲染卡片", status: "in_progress" },
			{ content: "修路径", status: "failed" },
			{ content: "补测试", status: "pending" },
		],
	};

	it("头行汇总状态计数,条目带 TaskN 标签与四态符号", () => {
		const text = todoPanelLines(card, 80, FRAME).map(plain).join("\n");

		assert.ok(text.includes("  › Tasks  1 running · 1 done · 1 failed · 1 pending"));
		assert.ok(text.includes("    ● Task 1  写工具"));
		assert.ok(text.includes("    ⠋ Task 2  渲染卡片"));
		assert.ok(text.includes("    × Task 3  修路径"));
		assert.ok(text.includes("    ○ Task 4  补测试"));
	});

	it("完成与失败不带删除线,进行中加粗,标签与圆点同青", () => {
		const lines = todoPanelLines(card, 80, FRAME);
		const find = (part: string): string => lines.find((line) => plain(line).includes(part)) ?? "";

		// 与子代理清单同一份色板:圆点与标签青、无删除线;失败整行红、无删除线
		assert.ok(find("● Task 1").includes(THEME.accent));
		assert.ok(find("写工具").includes(THEME.textSecondary));
		assert.equal(find("● Task 1").includes("\x1b[9m"), false);
		assert.ok(find("× Task 3").includes(THEME.error));
		assert.equal(find("× Task 3").includes("\x1b[9m"), false);
		assert.ok(find("⠋ Task 2").includes(THEME.accent));
		assert.ok(find("⠋ Task 2").includes("\x1b[1m"));
		// 进行中的正文是逐字符扫光,比静态色带出更多前景色码
		assert.ok((find("渲染卡片").match(/\x1b\[38;2;/g) ?? []).length > 1);
		assert.ok(find("○ Task 4").includes(THEME.accent));
		assert.ok(find("补测试").includes(THEME.textSecondary));
	});

	it("空表与已收尾的表都不进面板", () => {
		assert.deepEqual(todoPanelLines({ kind: "todo", items: [] }, 40, FRAME), []);
		const finished: TranscriptTodo = {
			kind: "todo",
			items: [
				{ content: "写工具", status: "completed" },
				{ content: "补测试", status: "failed" },
			],
		};
		assert.deepEqual(todoPanelLines(finished, 40, FRAME), []);
	});

	it("条目截断为单行,不折行", () => {
		const long: TranscriptTodo = {
			kind: "todo",
			items: [
				{
					content: "给工具与卡片补齐单元测试覆盖嵌套数组与枚举边界以及更多边界情形TAIL",
					status: "pending",
				},
			],
		};
		const lines = todoPanelLines(long, 34, FRAME);

		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(displayWidth(plain(line)) <= 34);
		// 面板只留可见的一行,不换行承接剩余内容
		assert.equal(plain(lines[1] ?? "").includes("TAIL"), false);
	});

	it("收起时只留头行,全部完成只走对话流", () => {
		assert.equal(todoPanelLines({ ...card, collapsed: true }, 80, FRAME).length, 1);

		const done: TranscriptTodo = {
			kind: "todo",
			items: [
				{ content: "写工具", status: "completed" },
				{ content: "补测试", status: "completed" },
			],
		};
		assert.deepEqual(todoPanelLines(done, 80, FRAME), []);
		assert.ok(
			todoCardLines(done, 80)
				.map(plain)
				.join("\n")
				.includes("› Tasks  2 done"),
		);
	});

	it("条目超过上限时显示剩余数", () => {
		const many: TranscriptTodo = {
			kind: "todo",
			items: Array.from({ length: TODO_PANEL_MAX_ITEMS + 2 }, (_, index) => ({
				content: `任务${index + 1}`,
				status: "pending" as const,
			})),
		};
		const text = todoPanelLines(many, 80, FRAME).map(plain).join("\n");

		assert.ok(text.includes("○ Task 1  任务1"));
		assert.ok(text.includes(`○ Task ${TODO_PANEL_MAX_ITEMS}  任务${TODO_PANEL_MAX_ITEMS}`));
		assert.equal(text.includes(`任务${TODO_PANEL_MAX_ITEMS + 1}`), false);
		assert.ok(text.includes("… 2 more"));
	});

	it("展开时头行只显示计数与耗时,转圈落在当前任务行", () => {
		const running: TranscriptTodo = {
			kind: "todo",
			running: true,
			taskStartedAt: Date.now() - 12_300,
			items: [
				{ content: "写工具", status: "completed" },
				{ content: "渲染卡片", status: "in_progress" },
			],
		};
		const lines = todoPanelLines(running, 60, FRAME).map(plain);
		const header = lines.find((line) => line.includes("Tasks")) ?? "";

		assert.ok(header.includes("1 running · 1 done"));
		assert.ok(header.includes("12.3s"));
		assert.equal(header.includes("⠋"), false);
		assert.ok(lines.some((line) => line.includes("⠋ Task 2  渲染卡片")));
	});

	it("折叠时头行保留转圈任务名,任务名超 30 显示列省略", () => {
		const running: TranscriptTodo = {
			kind: "todo",
			running: true,
			collapsed: true,
			taskStartedAt: Date.now() - 12_300,
			items: [
				{ content: "写工具", status: "completed" },
				{ content: "给常驻面板补齐单元测试覆盖折叠与展开以及窄屏排版", status: "in_progress" },
			],
		};
		const header = plain(todoPanelLines(running, 60, FRAME)[0] ?? "");

		assert.ok(header.includes("⠋"));
		assert.ok(header.includes("12.3s"));
		// 任务名截到 30 显示列:显示宽度不超过上限,且以省略号结尾
		const shown = /⠋ (.+?)\s*$/.exec(header)?.[1] ?? "";
		assert.ok(shown.endsWith("…"));
		assert.ok(displayWidth(shown) <= 30);
		// 头行不超宽
		assert.ok(displayWidth(header) <= 60);
	});

	it("没有进行中任务的头行只有计数", () => {
		const idle: TranscriptTodo = {
			kind: "todo",
			running: true,
			items: [{ content: "写工具", status: "pending" }],
		};
		const header = plain(todoPanelLines(idle, 60, FRAME)[0] ?? "");
		assert.equal(header.includes("⠋"), false);
		assert.ok(header.includes("› Tasks  1 pending"));
	});

	it("todoCardFromArgs 接受合法参数,拒绝一切不合预期的形状", () => {
		assert.deepEqual(
			todoCardFromArgs({
				explanation: " 调整  ",
				todos: [{ content: "写工具", status: "in_progress" }],
			}),
			{
				kind: "todo",
				explanation: " 调整  ",
				items: [{ content: "写工具", status: "in_progress" }],
				collapsed: false,
			},
		);
		// 空白说明当作没有说明
		assert.deepEqual(todoCardFromArgs({ explanation: "   ", todos: [] }), {
			kind: "todo",
			items: [],
			collapsed: false,
		});

		assert.equal(todoCardFromArgs({ todos: "nope" }), undefined);
		assert.equal(todoCardFromArgs({ todos: [{ content: "a" }] }), undefined);
		assert.equal(todoCardFromArgs({ todos: [{ content: "a", status: "done" }] }), undefined);
		assert.equal(todoCardFromArgs({ todos: [{ content: "   ", status: "pending" }] }), undefined);
		assert.equal(todoCardFromArgs({ todos: [{}] }), undefined);
		assert.equal(todoCardFromArgs({ explanation: 3, todos: [] }), undefined);
	});

	it("条目超过 5 条时默认收起", () => {
		const parsed = todoCardFromArgs({
			todos: Array.from({ length: 6 }, (_, index) => ({
				content: `任务${index + 1}`,
				status: index === 2 ? "in_progress" : "pending",
			})),
		});
		assert.ok(parsed !== undefined);
		assert.equal(parsed.collapsed, true);

		const text = todoPanelLines(parsed, 80, FRAME).map(plain).join("\n");
		assert.ok(text.includes("1 running · 5 pending"));
		assert.equal(text.includes("任务1"), false);

		// 展开后条目全部可见
		parsed.collapsed = false;
		assert.ok(todoPanelLines(parsed, 80, FRAME).map(plain).join("\n").includes("○ Task 1  任务1"));
	});
});

describe("收尾任务卡回到对话流", () => {
	const finished: TranscriptTodo = {
		kind: "todo",
		items: [
			{ content: "列出 src/tui 目录", status: "completed" },
			{ content: "统计各文件行数", status: "completed" },
			{ content: "找出最大的文件", status: "failed" },
			{ content: "用一句话汇总", status: "completed" },
		],
	};

	it("完成或失败都算收尾,还有待办或进行中则不算", () => {
		assert.equal(todoCardFinished(finished), true);
		assert.equal(
			todoCardFinished({
				kind: "todo",
				items: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "pending" },
				],
			}),
			false,
		);
		assert.equal(todoCardFinished({ kind: "todo", items: [] }), false);
	});

	it("头行汇总,清单沿用 TaskN 排版;收起时只留头行", () => {
		const text = todoCardLines(finished, 80).map(plain).join("\n");
		assert.ok(text.includes("  › Tasks  3 done · 1 failed"));
		assert.ok(text.includes("    ● Task 1  列出 src/tui 目录"));
		assert.ok(text.includes("    × Task 3  找出最大的文件"));

		const collapsed = todoCardLines({ ...finished, collapsed: true }, 80).map(plain);
		assert.equal(collapsed.length, 1);
		assert.ok(collapsed[0]?.includes("3 done · 1 failed"));
	});
});
