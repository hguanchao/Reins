import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lineText, lineWidth, plain } from "../../../src/tui/text/line.ts";
import { formatDuration, spinnerFrame, spinnerLine } from "../../../src/tui/widgets/spinner.ts";
import { renderBox } from "../../../src/tui/widgets/box.ts";

describe("spinnerFrame", () => {
	it("按时间取帧，同一段时间内保持不变", () => {
		assert.equal(spinnerFrame(0), spinnerFrame(50));
		assert.notEqual(spinnerFrame(0), spinnerFrame(120));
	});

	it("时间倒流也不会取到不存在的帧", () => {
		assert.equal(spinnerFrame(-1000), "⠋");
	});
});

describe("formatDuration", () => {
	it("毫秒、秒、分钟各有各的写法", () => {
		assert.equal(formatDuration(12), "12ms");
		assert.equal(formatDuration(999), "999ms");
		assert.equal(formatDuration(1500), "1.5s");
		assert.equal(formatDuration(65_000), "1m05s");
	});
});

describe("spinnerLine", () => {
	it("指示器与文字拼成一行", () => {
		const line = spinnerLine("正在思考", 0);
		assert.equal(lineText(line), "⠋ 正在思考 0ms");
	});
});

describe("renderBox", () => {
	it("每行宽度都一样，边框对齐", () => {
		const lines = renderBox({
			width: 24,
			title: "需要确认",
			lines: [plain("是否允许执行 bash？")],
		});
		for (const line of lines) assert.equal(lineWidth(line), 24);
assert.equal(lineText(lines[0]), "╭ 需要确认 ────────────╮");
		assert.equal(lineText(lines[1]), "│ 是否允许执行 bash？  │");
		assert.equal(lineText(lines[2]), "╰──────────────────────╯");
	});

	it("标题放不下时截断标题，边框不变形", () => {
		const lines = renderBox({ width: 12, title: "一个非常长的标题", lines: [] });
		for (const line of lines) assert.equal(lineWidth(line), 12);
		assert.equal(lineText(lines[0]), "╭ 一个非… ─╮");
	});

	it("内容自己折行，宽的汉字按两列算", () => {
		const lines = renderBox({ width: 12, lines: [plain("一二三四五六七八")] });
		for (const line of lines) assert.equal(lineWidth(line), 12);
		assert.equal(lineText(lines[1]), "│ 一二三四 │");
		assert.equal(lineText(lines[2]), "│ 五六七八 │");
	});

	it("宽度过窄时退回到能画出的最小宽度", () => {
		const lines = renderBox({ width: 1, lines: [plain("abc")] });
		for (const line of lines) assert.equal(lineWidth(line), 6);
	});

	it("内容为空时只有一个空行加下边框", () => {
		const lines = renderBox({ width: 10, lines: [] });
		assert.equal(lines.length, 2);
	});
});
