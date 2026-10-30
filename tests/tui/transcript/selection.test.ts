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
	visibleTextWidth,
} from "#src/tui/transcript.ts";
import type { TranscriptThinking, TranscriptTool } from "#src/tui/transcript.ts";
import { THEME } from "#src/tui/render/theme.ts";

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

	it("选区样式只覆盖选区，并跨过区间内的重置序列", () => {
		const line = `\x1b[31mhello\x1b[0m world`;
		assert.equal(
			highlightSelection(line, { from: 1, to: 3 }),
			`\x1b[31mh${THEME.selectionFg}${THEME.selectionBg}ell\x1b[31m\x1b[49mo\x1b[0m world`,
		);

		const reset = highlightSelection("ab\x1b[0mcd", { from: 0, to: 3 });
		assert.ok(
			reset.includes(
				`${THEME.selectionFg}${THEME.selectionBg}ab\x1b[0m${THEME.selectionFg}${THEME.selectionBg}cd`,
			),
		);
		assert.ok(reset.endsWith("\x1b[39m\x1b[49m"));
	});

	it("离开选区后恢复行内原有的前景色与底色", () => {
		const banded = `\x1b[48;2;22;25;29mhello\x1b[0m`;
		const highlighted = highlightSelection(banded, { from: 1, to: 2 });
		assert.ok(
			highlighted.includes(
				`${THEME.selectionFg}${THEME.selectionBg}el\x1b[39m\x1b[48;2;22;25;29mlo`,
			),
		);
	});

	it("展开详情复制的文本跳过行号，软换行不插换行", () => {
		const rows = [
			"# xz-acl",
			"",
			"## Getting started",
			"",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
			"",
			"## Project status",
			"If you have run out of energy or time for your project, put a note at the top of the README saying that development has slowed down or stopped completely. Someone may choose to fork your project or volunteer to step in as a maintainer or owner, allowing your project to keep going.",
		];
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "README.md",
			fullDetail: rows.map((row, index) => `${index + 1}  ${row}`).join("\n"),
			detailKind: "file",
			detailExpanded: true,
		};
		const view = buildTranscriptView(80, [{ prompt: "熟悉项目", response: [tool] }]);
		const first = view.lines.findIndex((line) => stripTerminalStyles(line).includes("Getting started"));
		// 最后一行可能被终端宽度拆成多个续行，取最后一个有内容的详情行
		const last = view.lines.reduce((found, line, index) => {
			const meta = view.lineMeta[index];
			return meta !== undefined && meta.contentStart > 0 && stripTerminalStyles(line).trim().length > 0
				? index
				: found;
		}, -1);
		assert.ok(first >= 0 && last > first);

		const firstPlain = stripTerminalStyles(view.lines[first] ?? "");
		const lastPlain = stripTerminalStyles(view.lines[last] ?? "");
		const selection = {
			anchor: { line: first, cell: firstPlain.indexOf("##") },
			focus: { line: last, cell: lastPlain.trimEnd().length - 1 },
		};
		const copied = selectionText(view, selection);

		assert.equal(/^\s*\d+  /m.test(copied), false);
		assert.ok(copied.includes("eiusmod tempor incididunt"));
		assert.ok(copied.includes("allowing your project to keep going."));
		assert.ok(copied.includes("## Getting started\n\nLorem ipsum"));
		// 中间行的行号列不进选区，选区从正文起点开始
		const middle = view.lines.findIndex((line, index) => {
			const meta = view.lineMeta[index];
			return (
				index > first &&
				index < last &&
				meta !== undefined &&
				meta.contentStart > 0 &&
				stripTerminalStyles(line).slice(meta.contentStart).trim().length > 0
			);
		});
		assert.ok(middle > 0);
		// 点在这一行的行号上，端点也落在正文起点
		assert.equal(selectionPoint(view, 40, 0, first + 1, 1)?.cell, view.lineMeta[first]?.contentStart);
		// 只有行号的空详情行不高亮行号
		const empty = view.lines.findIndex((line, index) => {
			const meta = view.lineMeta[index];
			return (
				index > first &&
				index < last &&
				meta !== undefined &&
				meta.contentStart > 0 &&
				stripTerminalStyles(line).slice(meta.contentStart).trim().length === 0
			);
		});
		assert.ok(empty > 0);
		assert.equal(
			selectionRange(
				empty,
				selection,
				visibleTextWidth(view.lines[empty] ?? ""),
				view.lineMeta[empty]?.contentStart ?? 0,
			),
			undefined,
		);
		const range = selectionRange(
			middle,
			selection,
			visibleTextWidth(view.lines[middle] ?? ""),
			view.lineMeta[middle]?.contentStart ?? 0,
		);
		assert.equal(range?.from, view.lineMeta[middle]?.contentStart);
	});

	it("提示块与思考正文里的数字开头行不被当成行号", () => {
		const thinking: TranscriptThinking = {
			kind: "thinkingBlock",
			header: "Thought for 1s",
			body: ["12  body line", "tail line"],
			partial: "",
			running: false,
			expanded: true,
		};
		const view = buildTranscriptView(40, [
			{ prompt: "first line\n12  second line\nthird line", response: [thinking] },
		]);
		const indexOf = (needle: string): number =>
			view.lines.findIndex((line) => stripTerminalStyles(line).includes(needle));

		const promptFirst = indexOf("first line");
		const promptLast = indexOf("third line");
		assert.ok(promptFirst >= 0 && promptLast > promptFirst);
		const promptCopy = selectionText(view, {
			anchor: { line: promptFirst, cell: 0 },
			focus: { line: promptLast, cell: 39 },
		});
		assert.ok(promptCopy.includes("12  second line"));
		assert.ok(promptCopy.includes("third line"));

		const bodyFirst = indexOf("12  body line");
		const bodyLast = indexOf("tail line");
		assert.ok(bodyFirst >= 0 && bodyLast > bodyFirst);
		const bodyCopy = selectionText(view, {
			anchor: { line: bodyFirst, cell: 0 },
			focus: { line: bodyLast, cell: 39 },
		});
		assert.ok(bodyCopy.includes("12  body line"));
		assert.ok(bodyCopy.includes("tail line"));
	});

	it("复制跳过提示块与工具结果的排版前缀，保留内容自身缩进", () => {
		const code = ["def foo():", "    return 1", "", "  indented"].join("\n");
		const tool: TranscriptTool = { kind: "tool", name: "Read", detail: "a.py", result: code, resultExpanded: true };
		const view = buildTranscriptView(60, [{ prompt: "看代码", response: [tool] }]);
		const indexOf = (needle: string): number =>
			view.lines.findIndex((line) => stripTerminalStyles(line).includes(needle));

		// 提示块：` › ` 只是排版，复制不该带上它
		const promptLine = indexOf("看代码");
		const promptCopy = selectionText(view, {
			anchor: { line: promptLine, cell: 0 },
			focus: { line: promptLine, cell: 59 },
		});
		assert.equal(promptCopy, "看代码");

		// 工具结果：色带前留白与带内一列内边距都是排版；代码自己的缩进要留着
		const first = indexOf("def foo");
		const last = indexOf("indented");
		const copy = selectionText(view, {
			anchor: { line: first, cell: 0 },
			focus: { line: last, cell: 59 },
		});
		assert.deepEqual(copy.split("\n"), ["def foo():", "    return 1", "", "  indented"]);
	});

	it("折叠块的省略提示不进复制文本", () => {
		const body = Array.from({ length: 70 }, (_, index) => `line-${index + 1}`).join("\n");
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			result: body,
			resultExpanded: true,
		};
		const view = buildTranscriptView(60, [{ prompt: "hi", response: [tool] }]);
		const indexOf = (needle: string): number =>
			view.lines.findIndex((line) => stripTerminalStyles(line).includes(needle));

		const ellipsis = indexOf("more lines");
		assert.ok(ellipsis > 0);
		const copy = selectionText(view, {
			anchor: { line: ellipsis - 2, cell: 0 },
			focus: { line: ellipsis, cell: 59 },
		});
		// 省略提示只是屏幕放不下的记号，粘到别处还要手动删一行
		assert.equal(copy.includes("more lines"), false);
		assert.ok(copy.includes("line-19"));
		assert.ok(copy.includes("line-20"));
	});
});
