import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	appendToolLine,
	collapseToolGroups,
	renderTranscript,
	scrollbarColumn,
	thinkingHeaderAtRow,
	toolGroupHeaderAtRow,
	toolHeaderAtRow,
	transcriptMetrics,
	type TranscriptLine,
	type TranscriptThinking,
	type TranscriptTool,
	type TranscriptToolGroup,
	type TranscriptTurn,
} from "../../src/tui/transcript.ts";
import { displayWidth } from "../../src/tui/menu-panel.ts";
import { THEME } from "../../src/tui/theme.ts";

const PROMPT_BG = "\x1b[48;2;22;25;29m";
const MESSAGE_TEXT = "\x1b[38;2;230;233;237m";
const NOTICE_TEXT = "\x1b[38;2;224;175;104m";

function plain(line: string): string {
	return line
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("思考区块", () => {
	function blockOf(header: string, running: boolean): TranscriptThinking {
		return {
			kind: "thinkingBlock",
			header,
			body: ["one", "two", "three", "four", "five", "six", "seven"],
			partial: "",
			running,
			expanded: false,
		};
	}

	it("运行中只显示最后五行，结束后收起，展开显示全文", () => {
		const block = blockOf("Thinking…", true);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };

		let text = renderTranscript(40, 12, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("  ✻ Thinking…"));
		assert.ok(
			["three", "four", "five", "six", "seven"].every((line) => text.includes(line)),
		);
		assert.equal(text.includes("one"), false);
		assert.equal(text.includes("two"), false);

		block.expanded = true;
		text = renderTranscript(40, 20, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("one"));

		block.running = false;
		block.expanded = false;
		block.header = "Thought for 1.0s";
		text = renderTranscript(40, 12, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("  ✻ Thought for 1.0s"));
		assert.equal(text.includes("seven"), false);

		block.expanded = true;
		text = renderTranscript(40, 20, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("one") && text.includes("seven"));
	});

	it("正文缩进到标题首字，只有正文铺底色", () => {
		const block = blockOf("Thinking…", true);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };
		const lines = renderTranscript(40, 12, [turn], 0);

		const header = lines.find((line) => plain(line).includes("Thinking…"));
		const body = lines.find((line) => plain(line).includes("three"));
		assert.ok(header);
		assert.ok(body);
		assert.ok(plain(header).startsWith("  ✻ Thinking…"));
		assert.ok(plain(body).startsWith("    three"));
		assert.equal(header.includes(THEME.surface), false);
		assert.equal(body.indexOf(THEME.surface), 3);
	});

	it("展开时只提亮标题标签，耗时保持弱化", () => {
		const block = blockOf("Thought for 1.0s", false);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };

		let header = renderTranscript(40, 12, [turn], 0).find((line) =>
			plain(line).includes("Thought for 1.0s"),
		);
		assert.ok(header?.includes(THEME.textSubtle));
		assert.equal(header?.includes(THEME.textPrimary), false);

		block.expanded = true;
		header = renderTranscript(40, 12, [turn], 0).find((line) =>
			plain(line).includes("Thought for 1.0s"),
		);
		assert.ok(header?.includes(`${THEME.textPrimary}  ◈ Thought for ${THEME.textSubtle}1.0s`));
		assert.equal(header?.includes(THEME.accent), false);
	});

	it("思考正文上方不留空行，下方留一行，展开标记换成菱形", () => {
		const block = blockOf("Thought for 1.0s", false);
		block.expanded = true;
		const lines = renderTranscript(40, 20, [{ prompt: "hi", response: [block] }], 0);
		const headerRow = lines.findIndex((line) => plain(line).includes("◈ Thought for"));
		assert.ok(headerRow >= 0);

		const first = lines[headerRow + 1] ?? "";
		assert.ok(first.includes(THEME.surface));
		assert.equal(plain(first).trim(), "one");

		const body = lines.find((line) => plain(line).includes("three")) ?? "";
		assert.ok(body.startsWith(`   ${THEME.surface}`));
		assert.ok(plain(body).startsWith("    three"));

		const lastRow = lines.findIndex((line) => plain(line).includes("seven"));
		assert.ok(lastRow >= 0);
		const bottom = lines[lastRow + 1] ?? "";
		assert.ok(bottom.includes(THEME.surface));
		assert.equal(plain(bottom).trim(), "");
	});

	it("标题行可以命中，正文行不能", () => {
		const block = blockOf("Thought for 1.0s", false);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };
		const row =
			renderTranscript(40, 12, [turn], 0).map(plain).findIndex((line) => line.includes("Thought for 1.0s")) + 1;

		assert.equal(thinkingHeaderAtRow(40, 12, [turn], 0, row), block);
		assert.equal(thinkingHeaderAtRow(40, 12, [turn], 0, row + 1), undefined);
	});
});

describe("工具调用行", () => {
	it("一行放得下时显示名称与参数，名称弱化、参数用正文色", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Read", detail: "README.md" }],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const line = lines.find((item) => plain(item).includes("› Read"));
		assert.ok(line);
		assert.ok(plain(line).startsWith("  › Read  README.md"));
		assert.ok(line.includes(THEME.textSubtle));
		assert.ok(line.includes(THEME.textPrimary));
	});

	it("参数放不下时保持一行，末尾省略", () => {
		const command =
			'cd /e/Projects/Reins2API && find . -not -path "*/node_modules/*" -type f | head -100';
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Bash", detail: command }],
		};
		const lines = renderTranscript(40, 10, [turn], 0).map(plain);

		const index = lines.findIndex((line) => line.includes("› Bash"));
		const line = lines[index] ?? "";
		assert.ok(line.startsWith("  › Bash  cd /e/Projects"));
		assert.ok(line.includes("…"));
		assert.equal(line.length, 40);
		// 折行会让下一条调用被推开，这里确认没有第二行
		assert.equal(lines[index + 1]?.includes("node_modules"), false);
	});

	it("失败行用 ×、错误色并带耗时", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [
				{ kind: "tool", name: "Bash", detail: "exit 1", isError: true, durationMs: 98 },
			],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const failed = lines.find((line) => plain(line).includes("× Bash"));
		assert.ok(failed);
		assert.ok(plain(failed).startsWith("  × Bash  exit 1 (98ms)"));
		assert.ok(failed.includes(THEME.error));
		assert.equal(failed.includes(THEME.textPrimary), false);
		assert.equal(failed.includes(THEME.textSubtle), false);
	});

	it("失败原因过长时续行，每一行都保持错误色", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Bash", detail: "x".repeat(100), isError: true, durationMs: 5 }],
		};
		const lines = renderTranscript(30, 10, [turn], 0);

		const failed = lines.filter((line) => plain(line).includes("x"));
		assert.ok(failed.length > 1);
		assert.ok(failed.every((line) => line.includes(THEME.error)));
	});

	it("展开成功工具时在调用行下方显示结果", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			group: undefined,
			result: "all tests passed\nsecond line",
			resultExpanded: true,
		};
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("all tests passed"));
		assert.ok(text.includes("second line"));
	});

	it("没有参数时只显示工具名", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Ls", detail: "" }],
		};
		const line = renderTranscript(40, 8, [turn], 0).find((item) => plain(item).includes("› Ls"));

		assert.ok(line);
		assert.equal(plain(line).trimEnd().endsWith("  › Ls"), true);
	});

	it("展开时保留目标并在名称下方显示完整命令", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			fullDetail: "cd /work && npm test | tail -5",
			detailExpanded: true,
		};
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("◆ Bash  npm test"));
		assert.ok(text.includes("cd /work && npm test | tail -5"));
	});

	it("没有完整命令时双击不给命中区", () => {
		const tool: TranscriptTool = { kind: "tool", name: "Bash", detail: "npm test" };
		const turn: TranscriptTurn = { prompt: "hi", response: [tool] };
		const row = renderTranscript(60, 10, [turn], 0).map(plain).findIndex((line) => line.includes("› Bash")) + 1;

		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, row), undefined);
	});

	it("有完整命令时标题行可命中，展开后的续行不可命中", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			fullDetail: "cd /work && npm test | tail -5",
		};
		const turn: TranscriptTurn = { prompt: "hi", response: [tool] };
		const row = renderTranscript(60, 10, [turn], 0).map(plain).findIndex((line) => line.includes("› Bash")) + 1;

		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, row), tool);

		tool.detailExpanded = true;
		const rows = renderTranscript(60, 10, [turn], 0).map(plain);
		const expandedRow = rows.findIndex((line) => line.includes("◆ Bash")) + 1;
		const bodyRow = rows.findIndex((line) => line.includes("cd /work")) + 1;

		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, expandedRow), tool);
		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, bodyRow), undefined);
	});

	it("结果指标显示在折叠行末尾，没有参数时跟在名称后面", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [
				{ kind: "tool", name: "Read", detail: "a.ts", metric: "100 lines" },
				{ kind: "tool", name: "List", detail: "", metric: "2 entries" },
			],
		};
		const text = renderTranscript(60, 10, [turn], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Read  a.ts (100 lines)"));
		assert.ok(text.includes("  › List (2 entries)"));
	});

	it("指标放不下时省略，不挤掉参数", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Read", detail: "a.ts", metric: "100 lines" }],
		};
		const line = renderTranscript(24, 10, [turn], 0)
			.map(plain)
			.find((item) => item.includes("› Read"));

		assert.ok(line);
		assert.equal(line.includes("100 lines"), false);
		assert.ok(line.includes("a.ts"));
	});

	it("多行完整参数逐行展开", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "auth.ts",
			fullDetail: "path: src/auth.ts\nedit 1: old -> new",
			detailExpanded: true,
		};
		const text = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  ◆ Edit  auth.ts"));
		assert.ok(text.includes("    path: src/auth.ts"));
		assert.ok(text.includes("    edit 1: old -> new"));
	});

	it("只读工具展开后显示结果内容，而不是参数清单", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			metric: "2 lines",
			fullDetail: "1  line 1\n2  line 2",
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const text = lines.map(plain).join("\n");

		assert.ok(text.includes("  ◆ Read  a.ts"));
		assert.equal(text.includes("(2 lines)"), false);
		assert.ok(text.includes("    1  line 1"));
		assert.ok(text.includes("    2  line 2"));
		assert.equal(text.includes("path:"), false);
		assert.ok(lines.some((line) => line.includes(THEME.surface)));

		// 标题行不铺色带；详情从标题标记列开始铺
		const head = lines.find((line) => plain(line).includes("◆ Read"));
		const body = lines.find((line) => plain(line).includes("1  line 1"));
		assert.ok(plain(head ?? "").startsWith("  "));
		assert.equal(head?.includes(THEME.surface), false);
		assert.ok(body?.startsWith(`   ${THEME.surface}`));
	});

	it("展开标题与 Thought 同色，文件路径用实线下划线", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			linkTarget: "file:///work/a.ts",
			fullDetail: "1  line 1",
			detailKind: "file",
			detailExpanded: true,
		};
		const head =
			renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0).find((line) =>
				plain(line).includes("◆ Read"),
			) ?? "";

		assert.ok(head.includes(THEME.textPrimary));
		assert.equal(head.includes(THEME.accent), false);
		assert.ok(head.includes(THEME.path));
		assert.ok(head.includes("\x1b[4m"));
		assert.equal(head.includes("\x1b]8;;"), false);
	});

	it("展开详情上方不留空行，下方留一行", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			fullDetail: "1  line 1",
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(40, 12, [{ prompt: "hi", response: [tool] }], 0);
		const headRow = lines.findIndex((line) => plain(line).includes("◆ Read"));
		assert.ok(headRow >= 0);

		const content = lines[headRow + 1] ?? "";
		const bottom = lines[headRow + 2] ?? "";

		assert.ok(content.includes(THEME.surface));
		assert.ok(plain(content).includes("1  line 1"));
		assert.ok(bottom.includes(THEME.surface));
		assert.equal(plain(bottom).trim(), "");
	});

	it("文件详情换行时悬挂缩进到内容列", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			fullDetail: `1  ${"x".repeat(100)}`,
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(40, 20, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.filter((line) => line.includes("x"));

		assert.ok(lines.length > 1);
		// 2 列标题缩进 + 1 列带内缩进 + 行号与分隔（3 列）
		assert.ok(lines[1]?.startsWith("       "));
		assert.equal(lines[1]?.startsWith("   1"), false);
	});

	it("diff 详情按增删与 hunk 着色", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "a.ts",
			fullDetail: "@@ line 1 @@\n1 - old\n1 + new\n2   keep",
			detailKind: "diff",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const hunk = lines.find((line) => plain(line).includes("@@ line 1 @@"));
		const removed = lines.find((line) => plain(line).includes("1 - old"));
		const added = lines.find((line) => plain(line).includes("1 + new"));

		assert.ok(hunk?.includes(THEME.accent));
		// 增删改为整行底色，标记本身仍用成功/失败色
		assert.ok(removed?.includes(THEME.diffDeleteBg));
		assert.ok(removed?.includes(THEME.error));
		assert.ok(added?.includes(THEME.diffInsertBg));
		assert.ok(added?.includes(THEME.success));
	});

	it("diff 的代码按语法着色，行尾填充回到底色不拖彩色", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "retry.ts",
			fullDetail: '1 + const backoff = Math.min(250, 5_000);\n2   // 注释',
			detailKind: "diff",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const added = lines.find((line) => plain(line).includes("const backoff"));
		const commented = lines.find((line) => plain(line).includes("// 注释"));

		assert.ok(added?.includes(THEME.syntaxKeyword));
		assert.ok(added?.includes(THEME.syntaxNumber));
		assert.ok(commented?.includes(THEME.syntaxComment));
		// 上下文行没有底色，仍用浮起表面铺满
		assert.ok(commented?.includes(THEME.surface));
	});

	it("认不出语言时 diff 不着色，但增删底色仍在", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "notes",
			fullDetail: "1 + const a = 1;",
			detailKind: "diff",
			detailExpanded: true,
		};
		const line = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0).find((item) =>
			plain(item).includes("const a = 1;"),
		);

		assert.ok(line?.includes(THEME.diffInsertBg));
		assert.equal(line?.includes(THEME.syntaxKeyword), false);
	});

	it("diff 每行宽度精确等于终端宽度，底色铺满整行", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "a.ts",
			fullDetail: "1 - old = 1;\n1 + const n = 2;\n2   // 注释",
			detailKind: "diff",
			detailExpanded: true,
		};
		const lines = renderTranscript(50, 12, [{ prompt: "hi", response: [tool] }], 0);
		const body = lines.filter((line) => /^\s+\d+ /.test(plain(line)));

		assert.equal(body.length, 3);
		for (const line of body) {
			assert.equal(displayWidth(plain(line)), 50);
		}
	});

	it("折叠路径带 OSC 8 链接，宽度仍按纯文本计算", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			linkTarget: "file:///work/src/a.ts",
		};
		const line = renderTranscript(40, 8, [{ prompt: "hi", response: [tool] }], 0).find((item) =>
			item.includes("Read"),
		);

		assert.ok(line?.includes("\x1b]8;;file:///work/src/a.ts\x1b\\a.ts\x1b]8;;\x1b\\"));
		assert.ok(plain(line ?? "").startsWith("  › Read  a.ts"));
		assert.equal(plain(line ?? "").length, 40);
	});
});

describe("工具组", () => {
	const read = (path: string): TranscriptTool => ({ kind: "tool", name: "Read", detail: path, group: "read" });
	const list = (path: string): TranscriptTool => ({ kind: "tool", name: "List", detail: path, group: "list" });
	const search = (pattern: string): TranscriptTool => ({ kind: "tool", name: "Grep", detail: pattern, group: "search" });

	function groupOf(members: readonly TranscriptTool[], expanded: boolean): TranscriptToolGroup {
		return { kind: "toolGroup", members: [...members], expanded };
	}

	function kindAt(lines: readonly TranscriptLine[], index: number): string | undefined {
		const line = lines[index];
		return typeof line === "string" || line === undefined ? undefined : line.kind;
	}

	function groupAt(lines: readonly TranscriptLine[], index: number): TranscriptToolGroup {
		const line = lines[index];
		if (typeof line !== "object" || line === null || line.kind !== "toolGroup") {
			throw new Error("expected a tool group");
		}
		return line;
	}

	it("两个以上连续只读调用折叠成组头", () => {
		const group = groupOf([read("a.ts"), read("b.ts"), list("src")], false);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Read 2 files, Listed 1 dir"));
		assert.equal(text.includes("a.ts"), false);
	});

	it("展开后按成员缩进显示完整工具行", () => {
		const group = groupOf([read("a.ts"), read("b.ts"), list("src")], true);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  ◈ Read 2 files, Listed 1 dir"));
		assert.ok(text.includes("    › Read  a.ts"));
		assert.ok(text.includes("    › Read  b.ts"));
		assert.ok(text.includes("    › List  src"));
	});

	it("组头按 Read、Listed、Searched 汇总并处理单复数", () => {
		const group = groupOf([read("a"), list("src"), search("TODO"), search("FIXME")], false);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("Read 1 file, Listed 1 dir, Searched 2 patterns"));
	});

	it("只有一个成员时仍按普通工具行显示", () => {
		const group = groupOf([read("a.ts")], false);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Read  a.ts"));
		assert.equal(text.includes("Read 1 file"), false);
	});

	it("追加工具时只在连续只读调用之间成组", () => {
		const lines: TranscriptLine[] = [];
		appendToolLine(lines, read("a"), true);
		assert.equal(kindAt(lines, 0), "tool");

		appendToolLine(lines, read("b"), true);
		const group = groupAt(lines, 0);
		assert.equal(group.members.length, 2);
		assert.equal(group.expanded, true);

		appendToolLine(lines, { kind: "tool", name: "Bash", detail: "npm test" }, true);
		assert.equal(kindAt(lines, 1), "tool");

		appendToolLine(lines, read("c"), true);
		appendToolLine(lines, read("d"), true);
		const next = groupAt(lines, 2);
		assert.equal(next.members.length, 2);

		lines.push("text");
		appendToolLine(lines, read("e"), true);
		assert.equal(kindAt(lines, lines.length - 1), "tool");

		collapseToolGroups(lines);
		assert.equal(group.expanded, false);
		assert.equal(next.expanded, false);
	});

	it("组头可以命中，成员行不能", () => {
		const group = groupOf([read("a.ts"), read("b.ts")], false);
		const turn: TranscriptTurn = { prompt: "hi", response: [group] };
		const row =
			renderTranscript(40, 10, [turn], 0)
				.map(plain)
				.findIndex((line) => line.includes("Read 2 files")) + 1;

		assert.equal(toolGroupHeaderAtRow(40, 10, [turn], 0, row), group);
		assert.equal(toolGroupHeaderAtRow(40, 10, [turn], 0, row + 1), undefined);
	});

	it("展开的组成员行可以各自命中并展开详情", () => {
		const first: TranscriptTool = { ...read("a.ts"), fullDetail: "path: src/a.ts" };
		const second: TranscriptTool = { ...read("b.ts"), fullDetail: "path: src/b.ts" };
		const group = groupOf([first, second], true);
		const turn: TranscriptTurn = { prompt: "hi", response: [group] };
		const rows = renderTranscript(60, 12, [turn], 0).map(plain);
		const headerRow = rows.findIndex((line) => line.includes("Read 2 files")) + 1;
		const firstRow = rows.findIndex((line) => line.includes("› Read  a.ts")) + 1;
		const secondRow = rows.findIndex((line) => line.includes("› Read  b.ts")) + 1;

		assert.equal(toolGroupHeaderAtRow(60, 12, [turn], 0, headerRow), group);
		assert.equal(toolHeaderAtRow(60, 12, [turn], 0, firstRow), first);
		assert.equal(toolHeaderAtRow(60, 12, [turn], 0, secondRow), second);
		assert.equal(toolGroupHeaderAtRow(60, 12, [turn], 0, firstRow), undefined);

		first.detailExpanded = true;
		const text = renderTranscript(60, 12, [turn], 0)
			.map(plain)
			.join("\n");
		assert.ok(text.includes("path: src/a.ts"));
	});
});

describe("块级间距", () => {
	function rowsOf(response: readonly TranscriptLine[]): readonly string[] {
		return renderTranscript(40, 12, [{ prompt: "hi", response }], 0)
			.map(plain)
			.map((line) => line.trimEnd());
	}

	it("正文与工具批次之间空一行，连续工具之间保持紧凑", () => {
		const rows = rowsOf([
			"先看看项目结构。",
			{ kind: "tool", name: "Bash", detail: "ls" },
			{ kind: "tool", name: "List", detail: "." },
		]);

		const textRow = rows.findIndex((line) => line.includes("先看看项目结构"));
		const bashRow = rows.findIndex((line) => line.includes("› Bash"));
		const listRow = rows.findIndex((line) => line.includes("› List"));

		assert.equal(bashRow, textRow + 2);
		assert.equal(rows[textRow + 1], "");
		assert.equal(listRow, bashRow + 1);
	});

	it("失败行独立成块，前后各空一行", () => {
		const rows = rowsOf([
			{ kind: "tool", name: "Bash", detail: "ls" },
			{ kind: "tool", name: "Bash", detail: "exit 1", isError: true, durationMs: 5 },
			"换个方式继续。",
		]);

		const okRow = rows.findIndex((line) => line.includes("› Bash"));
		const failedRow = rows.findIndex((line) => line.includes("× Bash"));
		const textRow = rows.findIndex((line) => line.includes("换个方式继续"));

		assert.equal(failedRow, okRow + 2);
		assert.equal(rows[okRow + 1], "");
		assert.equal(textRow, failedRow + 2);
		assert.equal(rows[failedRow + 1], "");
	});

	it("思考块与正文之间空一行，标题与思考正文保持相邻", () => {
		const block: TranscriptThinking = {
			kind: "thinkingBlock",
			header: "Thinking…",
			body: ["先读文件", "再决定"],
			partial: "",
			running: true,
			expanded: true,
		};
		const rows = rowsOf([block, "开始吧。"]);

		const headerRow = rows.findIndex((line) => line.includes("Thinking…"));
		const lastBodyRow = rows.findIndex((line) => line.includes("再决定"));
		const textRow = rows.findIndex((line) => line.includes("开始吧"));

		// 标题、两行正文、下内边距、块间距、正文
		assert.equal(lastBodyRow, headerRow + 2);
		assert.equal(textRow, lastBodyRow + 3);
		assert.equal(rows[lastBodyRow + 1], "");
		assert.equal(rows[lastBodyRow + 2], "");
	});
});

describe("对话流", () => {
	it("用户提示使用 #16191d 背景和指定前缀/正文颜色，上下留一行背景", () => {
		const lines = renderTranscript(40, 8, [{ prompt: "hello", response: [] }], 0);

		assert.equal(lines.length, 8);
		assert.ok(plain(lines[1] ?? "").startsWith(" › hello"));
		assert.equal(plain(lines[1] ?? "").length, 40);
		assert.ok((lines[0] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.ok((lines[2] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(MESSAGE_TEXT));
		assert.equal((lines[3] ?? "").includes(PROMPT_BG), false);
	});

	it("提示正文最多三行，超出用省略号", () => {
		const lines = renderTranscript(20, 10, [{ prompt: "一".repeat(50), response: [] }], 0);

		assert.ok((lines[0] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.ok((lines[2] ?? "").includes(PROMPT_BG));
		assert.ok((lines[3] ?? "").includes(PROMPT_BG));
		assert.ok((lines[4] ?? "").includes(PROMPT_BG));
		assert.equal((lines[5] ?? "").includes(PROMPT_BG), false);
		assert.ok(plain(lines[3] ?? "").includes("…"));
	});

	it("回复滚出视口后提示吸顶，下面固定一行 gap", () => {
		const response = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
		const lines = renderTranscript(40, 6, [{ prompt: "hello", response }], 6);

		assert.ok(plain(lines[1] ?? "").startsWith(" › hello"));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.equal(plain(lines[3] ?? "").includes("›"), false);
		assert.equal((lines[3] ?? "").includes(PROMPT_BG), false);
		assert.ok(plain(lines[4] ?? "").startsWith("  g"));
		assert.ok(plain(lines[5] ?? "").startsWith("  h"));
		assert.ok((lines[4] ?? "").includes(MESSAGE_TEXT));
		assert.equal(plain(lines[0] ?? "").endsWith("│"), false);
		assert.ok(plain(lines[0] ?? "").endsWith(" "));
		assert.ok(plain(lines[3] ?? "").endsWith("█"));
	});

	it("跨过下一条提示时滚动连续，不会被吸顶吞掉位移", () => {
		const turns: TranscriptTurn[] = [
			{ prompt: "one", response: ["x"] },
			{ prompt: "two", response: ["a", "b", "c"] },
		];
		const render = (top: number): string =>
			renderTranscript(40, 8, turns, top)
				.map((line) => plain(line).slice(0, -2))
				.join("\n");

		const at3 = render(3);
		const at4 = render(4);
		const at5 = render(5);
		const bottom = render(6);
		assert.notEqual(at3, at4);
		assert.notEqual(at4, at5);
		assert.ok(at5.includes(" › one"));
		assert.ok(bottom.includes(" › two"));
		assert.ok(bottom.includes("c"));
	});

	it("上一条回复和下一条提示之间留一行间距", () => {
		const lines = renderTranscript(
			40,
			20,
			[
				{ prompt: "one", response: ["x"] },
				{ prompt: "two", response: [] },
			],
			0,
		);

		assert.ok(plain(lines[4] ?? "").includes("x"));
		assert.equal((lines[5] ?? "").includes(PROMPT_BG), false);
		assert.ok((lines[6] ?? "").includes(PROMPT_BG));
		assert.ok(plain(lines[7] ?? "").startsWith(" › two"));
	});

	it("内容只超出少量行时，滚动仍然逐行移动内容", () => {
		const turn: TranscriptTurn = {
			prompt: "hello",
			response: ["r1", "r2", "r3", "r4", "r5", "r6"],
		};
		const at1 = renderTranscript(40, 8, [turn], 1)
			.map((line) => plain(line).slice(0, -2))
			.join("\n");
		const at2 = renderTranscript(40, 8, [turn], 2)
			.map((line) => plain(line).slice(0, -2))
			.join("\n");

		assert.notEqual(at1, at2);
		// 提示吸顶后，第一行内容被盖住，视口里从第二行开始
		assert.equal(at1.includes("r1"), false);
		assert.ok(at1.includes("r2"));
		assert.ok(at2.includes("r3"));
	});

	it("只有翻页留白、内容未超出视口时不显示滚动条", () => {
		const lines = renderTranscript(
			40,
			12,
			[
				{ prompt: "one", response: ["x"] },
				{ prompt: "two", response: [] },
			],
			6,
		);

		assert.ok(lines.every((line) => !plain(line).includes("█")));
		// 翻页仍然生效：第二条提示停在视口顶部
		assert.ok(plain(lines[1] ?? "").startsWith(" › two"));
	});

	it("给出最后一条提示的起始行，供发送后翻页", () => {
		const metrics = transcriptMetrics(40, 6, [
			{ prompt: "a", response: ["x"] },
			{ prompt: "b", response: [] },
		]);

		assert.equal(metrics.totalLines, 10);
		assert.equal(metrics.scrollLines, 12);
		assert.equal(metrics.lastPromptStart, 6);
	});

	it("启动警告作为对话流顶部的系统消息显示", () => {
		const lines = renderTranscript(40, 6, [], 0, "Warning: No provider openai");
		const text = lines.map(plain).join("\n");

		assert.ok(text.includes("! Warning:"));
		assert.ok(text.includes("No provider"));
		assert.ok(plain(lines[0] ?? "").startsWith("  ! Warning:"));
		assert.ok((lines[0] ?? "").includes(NOTICE_TEXT));
		assert.equal((lines[0] ?? "").includes(PROMPT_BG), false);
	});

	it("警告参与行数与滚动计算", () => {
		const metrics = transcriptMetrics(40, 6, [], `Warning: ${"x".repeat(200)}`);

		assert.ok(metrics.totalLines > 6);
	});

	it("没有轮次也没有警告时保持空白", () => {
		assert.deepEqual(renderTranscript(40, 3, [], 0), ["", "", ""]);
	});

	it("内容没有超出视口时不显示滚动条", () => {
		const lines = renderTranscript(40, 10, [], 0, "Warning: No provider openai");

		assert.ok(lines.every((line) => !plain(line).includes("█")));
	});
	it("思考标题用弱一档的颜色，跟正文区分", () => {
		const block: TranscriptThinking = {
			kind: "thinkingBlock",
			header: "Thought for 1.2s",
			body: ["reasoning"],
			partial: "",
			running: false,
			expanded: false,
		};
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: ["answer", block],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const notice = lines.find((line) => plain(line).includes("Thought for"));
		const body = lines.find((line) => plain(line).includes("answer"));
		assert.ok(notice?.includes(THEME.textSubtle));
		assert.equal(notice?.includes(THEME.textPrimary), false);
		assert.ok(body?.includes(THEME.textPrimary));
	});

	it("警告备注用 ! Warning: 和警告色", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "warning", text: "fallback model used" }],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const warning = lines.find((line) => plain(line).includes("! Warning: fallback model used"));
		assert.ok(warning);
		assert.ok(plain(warning).startsWith("  ! Warning:"));
		assert.ok(warning.includes(THEME.warning));
		assert.equal(warning.includes(THEME.error), false);
	});

	it("错误消息用 × 开头和错误色，出事时一眼能看见", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: ["answer", { text: "Error: boom", kind: "error" }],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const failed = lines.find((line) => plain(line).includes("× Error: boom"));
		const body = lines.find((line) => plain(line).includes("answer"));
		assert.ok(failed);
		assert.ok(plain(failed).startsWith("  × Error: boom"));
		assert.ok(failed.includes(THEME.error));
		assert.equal(failed.includes(THEME.textPrimary), false);
		assert.equal(body?.includes(THEME.error), false);
	});
});

describe("滚动条列", () => {
	function marks(height: number, total: number, top: number): string {
		return scrollbarColumn(height, total, top).map(plain).join("");
	}

	it("滑块只有一段，两端是轨道", () => {
		const column = marks(10, 100, 45);
		const first = column.indexOf("█");
		const last = column.lastIndexOf("█");

		assert.ok(first > 0);
		assert.ok(last < column.length - 1);
		// 首尾之间不能有轨道，否则滑块就是断的
		assert.equal(column.slice(first, last + 1).includes(" "), false);
	});

	it("滚到顶部时滑块贴顶，到底部时贴底", () => {
		assert.ok(marks(10, 100, 0).startsWith("█"));
		assert.ok(marks(10, 100, 90).endsWith("█"));
	});

	it("滚过内容末尾时滑块仍停在底部", () => {
		assert.ok(marks(10, 20, 999).endsWith("█"));
	});

	it("内容没超出视口时整列为空", () => {
		assert.equal(marks(10, 10, 0).trim(), "");
	});
});
