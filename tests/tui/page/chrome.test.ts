import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { actionLines, pageTitle, subtleLine } from "#src/tui/page/chrome.ts";
import { displayWidth } from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("页面标题", () => {
	it("截到宽度并用空格铺满整行", () => {
		const line = pageTitle("Reins — jobs", 20);
		assert.equal(displayWidth(plain(line)), 20);
		assert.ok(plain(line).startsWith("Reins — jobs"));
	});

	it("超宽标题截到宽度内", () => {
		const line = pageTitle("Reins — a very long title", 10);
		assert.ok(displayWidth(plain(line)) <= 10);
	});
});

describe("弱提示行", () => {
	it("缩进两列并压到宽度内", () => {
		const line = subtleLine("hello", 20);
		assert.equal(plain(line), "  hello");
		assert.ok(displayWidth(plain(subtleLine("x".repeat(40), 12))) <= 12);
	});
});

describe("动作条", () => {
	it("一条分隔线加按键提示", () => {
		const lines = actionLines(30, [["Esc", "close", THEME.textSubtle]]);
		assert.equal(lines.length, 2);
		assert.equal(plain(lines[0] ?? ""), "─".repeat(30));
		assert.ok(plain(lines[1] ?? "").includes("Esc close"));
		assert.equal(displayWidth(plain(lines[1] ?? "")), 30);
	});

	it("窄屏退回纯文本截断，宽度不越界", () => {
		const lines = actionLines(8, [
			["Enter", "view output", THEME.accent],
			["Esc", "back", THEME.textSubtle],
		]);
		assert.ok(displayWidth(plain(lines[1] ?? "")) <= 8);
	});

	it("零宽度给两行空串", () => {
		assert.deepEqual(actionLines(0, [["Esc", "close", THEME.textSubtle]]), ["", ""]);
	});
});
