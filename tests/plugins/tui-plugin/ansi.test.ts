import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ansiLines } from "../../../src/plugins/tui-plugin/ansi.ts";
import { lineText, type Style } from "../../../src/tui/text/line.ts";

const BASE: Style = { color: [225, 225, 225], background: [28, 28, 28] };

function only(text: string) {
	const lines = ansiLines(text, BASE);
	assert.equal(lines.length, 1, `expected one line: ${JSON.stringify(lines.map(lineText))}`);
	return lines[0];
}

describe("ANSI 输出", () => {
	it("保留前景色，reset 后回到基础色", () => {
		const line = only("\x1b[31mred\x1b[0m plain");
		assert.equal(lineText(line), "red plain");
		const red = line.find((span) => span.text === "red");
		assert.deepEqual(red?.style?.color, [128, 0, 0]);
		const plain = line.find((span) => span.text === " plain");
		assert.deepEqual(plain?.style?.color, BASE.color);
	});

	it("粗体、斜体、下划线、反显与删除线", () => {
		const line = only("\x1b[1;3;4;7;9mX\x1b[0m");
		const span = line.find((item) => item.text === "X");
		assert.equal(span?.style?.bold, true);
		assert.equal(span?.style?.italic, true);
		assert.equal(span?.style?.underline, true);
		assert.equal(span?.style?.reverse, true);
		assert.equal(span?.style?.strikethrough, true);
	});

	it("256 色与真彩色", () => {
		const cube = only("\x1b[38;5;196mX");
		assert.deepEqual(cube.find((span) => span.text === "X")?.style?.color, [255, 0, 0]);

		const truecolor = only("\x1b[38;2;1;2;3mX");
		assert.deepEqual(truecolor.find((span) => span.text === "X")?.style?.color, [1, 2, 3]);

		const background = only("\x1b[48;2;4;5;6mX");
		assert.deepEqual(background.find((span) => span.text === "X")?.style?.background, [4, 5, 6]);
	});

	it("光标、清屏与超链接序列不进入文字", () => {
		const line = only("\x1b[2K\x1b[1G\x1b]8;;https://example.com\x07link\x1b]8;;\x07");
		assert.equal(lineText(line), "link");
		assert.ok(!lineText(line).includes("\x1b"));
	});

	it("回车覆盖当前行，CRLF 仍是换行", () => {
		const lines = ansiLines("10%\r50%\r100% done\nnext", BASE).map(lineText);
		assert.deepEqual(lines, ["100% done", "next"]);
	});

	it("制表符留给后续换行排版", () => {
		assert.equal(lineText(only("a\tb")), "a\tb");
	});
});
