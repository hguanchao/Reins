import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildTranscriptView,
	highlightSelection,
	selectionPoint,
	selectionRange,
	selectionSpans,
	selectionText,
	stripTerminalStyles,
} from "../../../src/tui/transcript.ts";
import { THEME } from "../../../src/tui/render/theme.ts";

describe("文本选区", () => {
	function viewOf() {
		return buildTranscriptView(40, [
			{ prompt: "hi", response: ["  hello world", "  second line"] },
		]);
	}

	function lineIndex(view: ReturnType<typeof viewOf>, needle: string): number {
		return view.lines.findIndex((line) => stripTerminalStyles(line).includes(needle));
	}

	it("屏幕行列映射到视图行列，列超出时夹到最后一个可见字符", () => {
		const view = viewOf();
		const line = lineIndex(view, "hello");
		const plain = stripTerminalStyles(view.lines[line] ?? "");
		const visible = plain.trimEnd();
		const start = plain.indexOf("hello");

		assert.deepEqual(selectionPoint(view, 30, 0, line + 1, start + 1), { line, cell: start });
		assert.deepEqual(selectionPoint(view, 30, 0, line + 1, 10_000), {
			line,
			cell: Math.max(0, visible.length - 1),
		});
		assert.equal(selectionPoint(view, 30, 0, view.lines.length + 1, 1), undefined);
	});

	it("按显示列取出选区文本，反向拖动顺序相同", () => {
		const view = viewOf();
		const first = lineIndex(view, "hello");
		const second = lineIndex(view, "second");
		const firstPlain = stripTerminalStyles(view.lines[first] ?? "");
		const secondPlain = stripTerminalStyles(view.lines[second] ?? "");
		const startCell = firstPlain.indexOf("hello");
		const endCell = secondPlain.indexOf("second") + "second".length - 1;
		const expected = `hello world\n${secondPlain.slice(0, endCell + 1)}`;

		const forward = {
			anchor: { line: first, cell: startCell },
			focus: { line: second, cell: endCell },
		};
		assert.equal(selectionText(view, forward), expected);
		assert.equal(selectionText(view, { anchor: forward.focus, focus: forward.anchor }), expected);
		assert.equal(selectionSpans(forward), true);
		assert.equal(selectionSpans({ anchor: forward.anchor, focus: forward.anchor }), false);
	});

	it("只剩一行时尾部补齐的空格不进文本", () => {
		const view = viewOf();
		const line = lineIndex(view, "hello");
		const plain = stripTerminalStyles(view.lines[line] ?? "");
		const text = selectionText(view, {
			anchor: { line, cell: plain.indexOf("hello") },
			focus: { line, cell: plain.length - 1 },
		});
		assert.equal(text, "hello world");
	});

	it("选区范围覆盖首行到末行，行尾空白不参与高亮", () => {
		const selection = {
			anchor: { line: 2, cell: 4 },
			focus: { line: 5, cell: 1 },
		};
		assert.deepEqual(selectionRange(2, selection, 40), { from: 4, to: 39 });
		assert.deepEqual(selectionRange(3, selection, 40), { from: 0, to: 39 });
		assert.deepEqual(selectionRange(5, selection, 40), { from: 0, to: 1 });
		assert.equal(selectionRange(1, selection, 40), undefined);
		assert.equal(selectionRange(6, selection, 40), undefined);
		// 一行只有 12 个可见字符时，拖过行尾也只框到第 12 个
		assert.deepEqual(selectionRange(3, selection, 12), { from: 0, to: 11 });
		assert.deepEqual(selectionRange(2, selection, 3), { from: 2, to: 2 });
		assert.equal(selectionRange(3, selection, 0), undefined);
	});

	it("选区底色只覆盖选区，并跨过区间内的重置序列", () => {
		const line = `\x1b[31mhello\x1b[0m world`;
		assert.equal(
			highlightSelection(line, { from: 1, to: 3 }),
			`\x1b[31mh${THEME.selectionBg}ell\x1b[49mo\x1b[0m world`,
		);

		const reset = highlightSelection("ab\x1b[0mcd", { from: 0, to: 3 });
		assert.ok(reset.includes(`${THEME.selectionBg}ab\x1b[0m${THEME.selectionBg}cd`));
		assert.ok(reset.endsWith("\x1b[49m"));
	});

	it("离开选区后恢复行内原有的底色", () => {
		const banded = `\x1b[48;2;22;25;29mhello\x1b[0m`;
		const highlighted = highlightSelection(banded, { from: 1, to: 2 });
		assert.ok(highlighted.includes(`${THEME.selectionBg}el\x1b[48;2;22;25;29mlo`));
	});

	it("OSC 8 链接只去掉序列，保留链接文字", () => {
		const link = "\x1b]8;;http://example.com\x1b\\text\x1b]8;;\x1b\\";
		assert.equal(stripTerminalStyles(link), "text");

		const highlighted = highlightSelection(link, { from: 0, to: 3 });
		assert.ok(highlighted.includes(`${THEME.selectionBg}text`));
		assert.ok(highlighted.includes("http://example.com"));
	});
});
