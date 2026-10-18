import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { welcomeRows } from "../../../src/plugins/tui-plugin/welcome.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("首屏", () => {
	it("宽屏摆在圆角卡片里，包含品牌、说明与入口提示", () => {
		const rows = welcomeRows({ width: 80, rows: 24 });
		const text = rows.map(lineText);
		assert.equal(rows.length, 24, "fills the conversation area");
		assert.ok(text.some((line) => line.includes("╭") && line.includes("╮")), "box top");
		assert.ok(text.some((line) => line.includes("╰") && line.includes("╯")), "box bottom");
		assert.ok(text.some((line) => line.includes("REINS")), "wordmark");
		assert.ok(text.some((line) => line.includes("A terminal coding agent")), "tagline");
		assert.ok(text.some((line) => line.includes("/help")), "help hint");
		assert.ok(text.some((line) => line.includes("@file")), "file hint");
		assert.ok(text.some((line) => line.includes("Type a message below to start.")), "start hint");
		for (const row of rows) assert.ok(lineWidth(row) <= 80);
	});

	it("矮屏退回无框的紧凑版", () => {
		const rows = welcomeRows({ width: 50, rows: 10 });
		const text = rows.map(lineText);
		assert.equal(rows.length, 10);
		assert.ok(text.some((line) => line.includes("REINS")));
		assert.ok(text.some((line) => line.includes("A terminal coding agent")));
		assert.ok(!text.some((line) => line.includes("╭")), "no box when short");
	});

	it("极矮时只留品牌，不把输入框挤出去", () => {
		const rows = welcomeRows({ width: 40, rows: 3 });
		assert.equal(rows.length, 3);
		assert.ok(rows.map(lineText).some((line) => line.includes("REINS")));
	});
});
