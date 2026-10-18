import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	fileMenuRows,
	fuzzyMatchIndices,
	historyMenuRows,
	slashMenuRows,
} from "../../../src/plugins/tui-plugin/menu-view.ts";
import { THEME } from "../../../src/plugins/tui-plugin/theme.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

const COMMANDS = [
	{ name: "help", description: "Show help", tag: "built-in", insertText: "/help" },
	{ name: "exit", description: "Quit", tag: "built-in", insertText: "/exit" },
	{ name: "notify", description: "Notifications", tag: "built-in", insertText: "/notify " },
];

describe("斜杠命令下拉", () => {
	it("面板带上下框线，右侧嵌结果计数，选中项落在窗口里", () => {
		const layout = slashMenuRows(COMMANDS, 1, 40, 2);
		assert.equal(layout.visible, 2);
		assert.equal(layout.top, 0);
		// 框线、两行候选、框线
		assert.equal(layout.rows.length, 4);
		const rule = lineText(layout.rows[0]).trim();
		assert.equal(rule.length, 36);
		assert.ok(rule.startsWith("─".repeat(10)), "rule spans the panel");
		assert.ok(rule.endsWith("  3 ─"), "count sits inside the right end");
		assert.ok(lineText(layout.rows[1]).includes("/help"));
		assert.ok(lineText(layout.rows[1]).includes("Show help"));
		for (const row of layout.rows) assert.equal(lineWidth(row), 38);
	});

	it("框线不铺候选行的底色，色带止步于框线", () => {
		const layout = slashMenuRows(COMMANDS, 0, 40, 2);
		// 框线只染字形（前景色），整行连同补齐的空格都不写背景，由整屏铺底补成 base 色
		for (const span of [layout.rows[0], layout.rows.at(-1) ?? []].flat()) {
			assert.equal(span.style?.background, undefined);
		}
		// 候选行整行铺底：行尾补齐的空格也带着色带
		assert.equal(layout.rows[1].at(-1)?.style?.background, THEME.selectBg);
		assert.equal(layout.rows[2].at(-1)?.style?.background, THEME.band);
	});

	it("鼠标悬停的候选行亮一档，选中行仍用选中底色", () => {
		const layout = slashMenuRows(COMMANDS, 0, 40, 3, "", 1);
		assert.equal(layout.rows[1].at(-1)?.style?.background, THEME.selectBg, "selected row");
		assert.equal(layout.rows[2].at(-1)?.style?.background, THEME.menuHover, "hovered row");
		assert.equal(layout.rows[3].at(-1)?.style?.background, THEME.band, "idle row");
	});

	it("选中行带 ❯ 前缀，未选中行不带", () => {
		const layout = slashMenuRows(COMMANDS, 1, 40, 2);
		assert.ok(lineText(layout.rows[2]).includes("❯ /exit"));
		assert.ok(!lineText(layout.rows[1]).includes("❯"));
	});

	it("选中项越过窗口时窗口跟着下移", () => {
		const layout = slashMenuRows(COMMANDS, 2, 40, 2);
		assert.equal(layout.top, 1);
		assert.ok(lineText(layout.rows[1]).includes("/exit"));
		assert.ok(lineText(layout.rows[2]).includes("/notify"));
		assert.ok(lineText(layout.rows[3]).trim().startsWith("─"), "panel closes with a rule");
	});

	it("查询字符在标签里高亮，并显示来源标记", () => {
		const layout = slashMenuRows(COMMANDS, 0, 60, 3, "he");
		const row = layout.rows[1];
		const text = lineText(row);
		assert.ok(text.includes("[built-in]"), "provenance tag");
		assert.equal(row.find((span) => span.text === "he")?.style?.color, THEME.system, "matched characters");
		assert.ok(text.includes("❯ /help"), "label follows the selection prefix");

		assert.deepEqual(fuzzyMatchIndices("help", "hp"), [0, 3]);
		assert.deepEqual(fuzzyMatchIndices("help", "zz"), []);
	});
});

describe("历史下拉", () => {
	it("最近提交的在前，多行消息带行数", () => {
		const layout = historyMenuRows(["newer", "older\nsecond line"], 0, 40, 2);
		assert.ok(lineText(layout.rows[1]).includes("❯ newer"));
		assert.ok(lineText(layout.rows[2]).includes("older"));
		assert.ok(lineText(layout.rows[2]).includes("(+1 line)"));
	});
});

describe("文件下拉", () => {
	it("目录带尾斜杠，文件不带；框线右侧嵌匹配计数", () => {
		const layout = fileMenuRows(
			[
				{ path: "src", kind: "directory" },
				{ path: "src/app.ts", kind: "file" },
			],
			0,
			40,
			8,
			"2/7",
		);
		assert.ok(lineText(layout.rows[0]).includes("2/7"));
		assert.ok(lineText(layout.rows[1]).includes("@src/"));
		assert.ok(lineText(layout.rows[2]).includes("@src/app.ts"));
		for (const row of layout.rows) assert.equal(lineWidth(row), 38);
	});

	it("空结果不产生行", () => {
		assert.deepEqual(fileMenuRows([], 0, 40, 8), { rows: [], top: 0, visible: 0 });
	});

	it("文件路径里的命中字符同样高亮", () => {
		const layout = fileMenuRows(
			[{ path: "src/app.ts", kind: "file" }],
			0,
			60,
			8,
			"1/1",
			"sa",
		);
		const row = layout.rows[1];
		assert.ok(lineText(row).includes("@src/app.ts"));
		const matched = row.filter((span) => span.style?.color === THEME.system).map((span) => span.text);
		assert.ok(matched.join("").includes("s") && matched.join("").includes("a"), "matched path characters");
	});
});
