import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildTranscriptView,
	renderTranscript,
	renderTranscriptView,
	todoHeaderInView,
	toggleLastExpandable,
	type TranscriptTurn,
} from "../../src/tui/transcript.ts";
import { todoCardFromArgs, type TranscriptTodo } from "../../src/tui/todo-card.ts";
import { displayWidth } from "../../src/tui/text.ts";
import { THEME } from "../../src/tui/theme.ts";

function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("任务卡片", () => {
	const card: TranscriptTodo = {
		kind: "todo",
		explanation: "调整:先做渲染",
		items: [
			{ content: "写工具", status: "completed" },
			{ content: "渲染卡片", status: "in_progress" },
			{ content: "修路径", status: "failed" },
			{ content: "补测试", status: "pending" },
		],
	};

	it("四态符号、头行计数与说明行", () => {
		const text = renderTranscript(40, 14, [{ prompt: "go", response: [card] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Tasks  1/4"));
		assert.ok(text.includes("    调整:先做渲染"));
		assert.ok(text.includes("    ● 写工具"));
		assert.ok(text.includes("    ◐ 渲染卡片"));
		assert.ok(text.includes("    × 修路径"));
		assert.ok(text.includes("    ○ 补测试"));
	});

	it("完成与失败不带删除线,说明行斜体,进行中加粗,圆点与标签同青", () => {
		const lines = renderTranscript(40, 14, [{ prompt: "go", response: [card] }], 0);
		const find = (part: string): string => lines.find((line) => plain(line).includes(part)) ?? "";

		// 与子代理清单同一份色板:圆点青、无删除线;失败整行红、无删除线
		assert.ok(find("● 写工具").includes(THEME.accent));
		assert.equal(find("● 写工具").includes("\x1b[9m"), false);
		assert.ok(find("× 修路径").includes(THEME.error));
		assert.equal(find("× 修路径").includes("\x1b[9m"), false);
		assert.ok(find("◐ 渲染卡片").includes(THEME.accent));
		assert.ok(find("◐ 渲染卡片").includes("\x1b[1m"));
		assert.ok(find("调整:先做渲染").includes("\x1b[3m"));
	});

	it("空表渲染 cleared,不带条目", () => {
		const empty: TranscriptTodo = { kind: "todo", items: [] };
		const text = renderTranscript(40, 10, [{ prompt: "go", response: [empty] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Tasks  cleared"));
		assert.equal(text.includes("○"), false);
	});

	it("长条目折行并悬挂缩进到条目正文列", () => {
		const long: TranscriptTodo = {
			kind: "todo",
			items: [{ content: "给工具与卡片补齐单元测试,覆盖嵌套数组与枚举边界", status: "pending" }],
		};
		const lines = renderTranscript(30, 10, [{ prompt: "go", response: [long] }], 0).map(plain);

		const first = lines.findIndex((line) => line.includes("○ 给工具"));
		assert.ok(first >= 0);
		const continuation = lines[first + 1] ?? "";
		assert.ok(continuation.trim().length > 0);
		// 续行与首行正文对齐:缩进 4 列 + 标记与空格 2 列
		assert.equal(continuation.slice(0, 6), "      ");
	});

	it("卡片与相邻内容之间留空行", () => {
		const turn: TranscriptTurn = {
			prompt: "go",
			response: [
				card,
				{ kind: "tool", name: "Read", detail: "a.ts", group: "read", callId: "1" },
			],
		};
		const text = renderTranscript(40, 16, [turn], 0).map(plain).join("\n");

		const cardEnd = text.indexOf("○ 补测试");
		const toolStart = text.indexOf("› Read");
		assert.ok(cardEnd >= 0 && toolStart > cardEnd);
		// 卡片末行与工具行之间隔着一个空行
		assert.equal(text.slice(cardEnd, toolStart).split("\n").length, 3);
	});

	it("running 卡片的进行中行按帧重建为转圈与扫光,静态卡片不受帧影响", () => {
		const running: TranscriptTodo = { ...card, running: true };
		const view = buildTranscriptView(40, [{ prompt: "go", response: [running] }], undefined);
		assert.ok(view.liveTodoLines.size === 1);

		const staticText = renderTranscriptView(view, 16, 0).map(plain).join("\n");
		assert.ok(staticText.includes("◐ 渲染卡片"));

		const frame = { spinner: "⠋", sweepPhase: 0.5 };
		const animatedLines = renderTranscriptView(view, 16, 0, frame);
		const animatedText = animatedLines.map(plain).join("\n");
		assert.ok(animatedText.includes("⠋ 渲染卡片"));
		assert.equal(animatedText.includes("◐ 渲染卡片"), false);

		const animatedLine = animatedLines.find((line) => plain(line).includes("渲染卡片")) ?? "";
		// 扫光是逐字符 RGB 渐变,比静态色带出更多的前景色码
		assert.ok((animatedLine.match(/\x1b\[38;2;/g) ?? []).length > 1);
		assert.ok(animatedLine.includes("\x1b[1m"));

		// 回合结束 running 置 false 后重建,即使带帧也只剩静态行
		running.running = false;
		const frozen = buildTranscriptView(40, [{ prompt: "go", response: [running] }], undefined);
		assert.equal(frozen.liveTodoLines.size, 0);
		assert.ok(renderTranscriptView(frozen, 16, 0, frame).map(plain).join("\n").includes("◐ 渲染卡片"));
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

	it("条目超过 5 条时默认收起,收起卡片只占头行一行", () => {
		const card = todoCardFromArgs({
			todos: Array.from({ length: 6 }, (_, index) => ({
				content: `任务${index + 1}`,
				status: index === 2 ? "in_progress" : "pending",
			})),
		});
		assert.ok(card !== undefined);
		assert.equal(card.collapsed, true);

		const text = renderTranscript(40, 20, [{ prompt: "go", response: [card] }], 0)
			.map(plain)
			.join("\n");
		assert.ok(text.includes("› Tasks  0/6"));
		assert.equal(text.includes("任务1"), false);

		// 头行注册为命中区:双击据此切换收起/展开
		const view = buildTranscriptView(40, [{ prompt: "go", response: [card] }], undefined);
		const row =
			view.lines.findIndex((line) => plain(line).includes("Tasks")) + 1;
		assert.equal(todoHeaderInView(view, 20, 0, row), card);

		// 双击语义:collapsed 翻转后条目全部可见
		card.collapsed = false;
		const expanded = renderTranscript(40, 20, [{ prompt: "go", response: [card] }], 0)
			.map(plain)
			.join("\n");
		assert.ok(expanded.includes("○ 任务1"));
	});

	it("折叠头行运行期显示转圈任务名与耗时,任务名超 30 显示列省略", () => {
		const card: TranscriptTodo = {
			kind: "todo",
			running: true,
			collapsed: true,
			taskStartedAt: Date.now() - 12_300,
			items: [
				{ content: "写工具", status: "completed" },
				{ content: "给对话流任务卡片补齐单元测试覆盖折叠与展开", status: "in_progress" },
			],
		};
		const view = buildTranscriptView(60, [{ prompt: "go", response: [card] }], undefined);
		assert.equal(view.liveTodoLines.size, 1);

		// 静态占位只有计数;带帧重建后出现任务名与耗时
		assert.ok(renderTranscriptView(view, 12, 0).map(plain).join("\n").includes("› Tasks  1/2"));
		const frame = { spinner: "⠋", sweepPhase: 0.5 };
		const lines = renderTranscriptView(view, 12, 0, frame);
		const header = lines.find((line) => plain(line).includes("Tasks")) ?? "";
		const headerPlain = plain(header);
		assert.ok(headerPlain.includes("⠋"));
		assert.ok(headerPlain.includes("12.3s"));
		// 任务名截到 30 显示列:显示宽度不超过上限,且以省略号结尾
		const shown = /⠋ (.+?)  12\.3s/.exec(headerPlain)?.[1] ?? "";
		assert.ok(shown.endsWith("…"));
		assert.ok(displayWidth(shown) <= 30);
		// 头行不超宽
		assert.ok(displayWidth(headerPlain) <= 60);
	});

	it("没有进行中任务或已结束的折叠卡片,头行只有计数", () => {
		const idle: TranscriptTodo = {
			kind: "todo",
			running: true,
			collapsed: true,
			items: [{ content: "写工具", status: "completed" }],
		};
		const view = buildTranscriptView(60, [{ prompt: "go", response: [idle] }], undefined);
		assert.equal(view.liveTodoLines.size, 0);

		const done: TranscriptTodo = { ...idle, running: false, taskStartedAt: Date.now() };
		const frozen = buildTranscriptView(60, [{ prompt: "go", response: [done] }], undefined);
		assert.equal(frozen.liveTodoLines.size, 0);
		assert.ok(
			renderTranscriptView(frozen, 12, 0, { spinner: "⠋", sweepPhase: 0.5 })
				.map(plain)
				.join("\n")
				.includes("› Tasks  1/1"),
		);
	});

	it("Ctrl+E 展开或收起最近一张任务卡片", () => {
		const card: TranscriptTodo = {
			kind: "todo",
			collapsed: true,
			items: Array.from({ length: 6 }, (_, index) => ({
				content: `任务${index + 1}`,
				status: "pending",
			})),
		};
		const turns: TranscriptTurn[] = [{ prompt: "go", response: [card] }];

		assert.equal(toggleLastExpandable(turns), true);
		assert.equal(card.collapsed, false);
		assert.equal(toggleLastExpandable(turns), true);
		assert.equal(card.collapsed, true);
	});
});
