import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LineEditor } from "../../../src/tui/input/editor.ts";
import { plain } from "../../../src/tui/text/line.ts";

describe("单行编辑器", () => {
	it("按字素簇增删：退格删掉一整个组合序列", () => {
		const editor = new LineEditor();
		editor.insert("e\u0301"); // e + 组合用重音是一个字
		assert.equal(editor.text, "e\u0301");
		editor.backspace();
		assert.equal(editor.text, "");
	});

	it("光标移动与整字删除", () => {
		const editor = new LineEditor();
		editor.insert("hello world");
		editor.moveLeft();
		editor.moveLeft();
		editor.moveLeft();
		editor.moveLeft(); // 光标在 wor 的 r 后面：删掉一个词包括空白
		editor.deleteWordBefore();
		assert.equal(editor.text, "hello orld");
	});

	it("deleteWordBefore 连同空白一起删", () => {
		const editor = new LineEditor();
		editor.insert("ab  cd");
		for (let index = 0; index < 2; index += 1) editor.moveLeft();
		editor.deleteWordBefore();
		assert.equal(editor.text, "cd");
	});

	it("deleteWordBefore 删掉首词", () => {
		const editor = new LineEditor();
		editor.insert("ab");
		editor.moveEnd();
		editor.deleteWordBefore();
		assert.equal(editor.text, "");
	});

	it("deleteToStart / deleteToEnd 按 readline 语义", () => {
		const editor = new LineEditor();
		editor.insert("abcdef");
		editor.moveHome();
		editor.deleteToStart();
		assert.equal(editor.text, "abcdef"); // 光标已在首位，无事发生

		editor.moveEnd();
		editor.moveLeft();
		editor.moveLeft(); // 光标在 e 前：删掉之后的 ef
		editor.deleteToEnd();
		assert.equal(editor.text, "abcd");

		editor.clear();
		assert.equal(editor.text, "");
	});

	it("插到当前位置而不是末尾", () => {
		const editor = new LineEditor();
		editor.insert("ab");
		editor.moveLeft();
		editor.insert("X");
		assert.equal(editor.text, "aXb");
	});

	it("末尾 deleteForward 是空操作，中间可用", () => {
		const editor = new LineEditor();
		editor.insert("ab");
		editor.deleteForward();
		assert.equal(editor.text, "ab");
		editor.moveHome();
		editor.deleteForward();
		assert.equal(editor.text, "b");
	});

	it("换行折成空格", () => {
		const editor = new LineEditor();
		editor.insert("a\r\nb\nc");
		assert.equal(editor.text, "a b c");
	});

	it("越界移动夹紧", () => {
		const editor = new LineEditor();
		editor.moveLeft();
		editor.insert("x");
		assert.equal(editor.text, "x");
	});

	it("提交后清空并进历史，连发同一条不重复入史", () => {
		const editor = new LineEditor();
		editor.insert("hi");
		assert.equal(editor.submit(), "hi");
		assert.equal(editor.text, "");

		editor.insert("hi");
		editor.submit();
		editor.historyPrev();
		assert.equal(editor.text, "hi"); // 历史里只有一条
	});

	it("空白输入不入史", () => {
		const editor = new LineEditor();
		editor.insert("   ");
		editor.submit();
		editor.historyPrev();
		assert.equal(editor.text, ""); // 历史还是空的
	});

	it("历史翻上去再翻回来，回到之前打的草稿", () => {
		const editor = new LineEditor();
		editor.insert("first");
		editor.submit();
		editor.insert("second");
		editor.submit();

		editor.insert("draft");
		editor.historyPrev();
		assert.equal(editor.text, "second");
		editor.historyPrev();
		assert.equal(editor.text, "first");
		editor.historyPrev(); // 已经是第一条，停住
		assert.equal(editor.text, "first");
		editor.historyNext();
		assert.equal(editor.text, "second");
		editor.historyNext();
		assert.equal(editor.text, "draft"); // 回到草稿
	});
});

describe("编辑器渲染", () => {
	it("空内容显示占位文本，光标在提示符后", () => {
		const editor = new LineEditor();
		const render = editor.render({ width: 40, prompt: plain("❯ "), placeholder: "say something" });
		assert.equal(render.lines.length, 1);
		assert.equal(render.cursor.row, 0);
		assert.equal(render.cursor.col, "❯ ".length);
		assert.match(render.lines[0].map((s) => s.text).join(""), /say something/);
	});

	it("光标只由终端定位，内容里不反显", () => {
		const editor = new LineEditor();
		editor.insert("ab");
		const render = editor.render({ width: 20, prompt: plain("❯ ") });
		const row = render.cursor.row;
		const spans = render.lines[row];
		assert.ok(spans.every((span) => span.style?.reverse !== true), "no reverse caret");
		// 末尾补一格空白作落点，光标落在 ab 之后
		assert.equal(spans.map((span) => span.text).join(""), "❯ ab ");
		assert.equal(render.cursor.col, 4);
	});

	it("光标在中间时落在该字符所在的格子上", () => {
		const editor = new LineEditor();
		editor.insert("abc");
		editor.moveLeft();
		const render = editor.render({ width: 20, prompt: plain("❯ ") });
		const spans = render.lines[render.cursor.row];
		assert.ok(spans.every((span) => span.style?.reverse !== true), "no reverse caret");
		assert.equal(spans.map((span) => span.text).join(""), "❯ abc");
		assert.equal(render.cursor.col, 4);
	});

	it("折行后光标行号跟着内容移动", () => {
		const editor = new LineEditor();
		editor.insert("aaaa bbbb cccc");
	editor.moveHome();
		const render = editor.render({ width: 10, prompt: plain("") });
		assert.equal(render.cursor.row, 0);
		assert.equal(render.cursor.col, 0);
	});
});
