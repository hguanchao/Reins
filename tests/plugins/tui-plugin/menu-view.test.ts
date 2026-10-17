import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fileMenuRows, slashMenuRows } from "../../../src/plugins/tui-plugin/menu-view.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

const COMMANDS = [
	{ name: "help", description: "Show help", insertText: "/help" },
	{ name: "exit", description: "Quit", insertText: "/exit" },
	{ name: "notify", description: "Notifications", insertText: "/notify " },
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
});
