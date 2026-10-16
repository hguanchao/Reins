import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LineEditor } from "../../../src/tui/input/editor.ts";
import { lineText } from "../../../src/tui/text/line.ts";
import { displayWidth } from "../../../src/tui/text/width.ts";

const PROMPT = [{ text: "› ", style: { color: "cyan" } }] as const;

function renderText(editor: LineEditor, width = 20): string[] {
	return editor.render({ width, prompt: [...PROMPT] }).lines.map((line) => lineText(line));
}

describe("LineEditor", () => {
	it("插入与取回内容", () => {
		const editor = new LineEditor();
		editor.insert("hello");
		assert.equal(editor.text, "hello");
		editor.insert(" world");
		assert.equal(editor.text, "hello world");
	});

	it("粘贴进来的换行折成空格", () => {
		const editor = new LineEditor();
		editor.insert("第一行\n第二行\r\n第三行");
		assert.equal(editor.text, "第一行 第二行 第三行");
	});

	it("按字素簇退格，不会把 emoji 删掉一半", () => {
		const editor = new LineEditor();
		editor.insert("a👨‍👩‍👧");
		editor.backspace();
		assert.equal(editor.text, "a");
	});

	it("插入可能与前一个字素合并的内容后光标仍然正确", () => {
		const editor = new LineEditor();
		editor.insert("a");
		editor.insert("\u0301"); // 组合用重音符，与 a 合成一个簇
		editor.insert("b");
		assert.equal(editor.text, "a\u0301b");

		// 光标在 b 之后，退格删掉的应是 b，而不是合成的那个簇
		editor.backspace();
		assert.equal(editor.text, "a\u0301");
	});

	it("光标移动与按位置删除", () => {
		const editor = new LineEditor();
		editor.insert("abc");
		editor.moveLeft();
		editor.moveLeft();
		editor.insert("X");
		assert.equal(editor.text, "aXbc");
		editor.deleteForward();
		assert.equal(editor.text, "aXc");
		editor.moveHome();
		editor.insert("Y");
		assert.equal(editor.text, "YaXc");
		editor.moveEnd();
		editor.backspace();
		assert.equal(editor.text, "YaX");
	});

	it("在行首退格与在行尾删除都是空操作", () => {
		const editor = new LineEditor();
		editor.insert("ab");
		editor.moveHome();
		editor.backspace();
		editor.moveEnd();
		editor.deleteForward();
		assert.equal(editor.text, "ab");
	});

	it("删除光标前的一个词，连着前面的空白一起删", () => {
		const editor = new LineEditor();
		editor.insert("reins  看看 这个项目");
		editor.deleteWordBefore();
		assert.equal(editor.text, "reins  看看 ");
		editor.deleteWordBefore();
		assert.equal(editor.text, "reins  ");
	});

	it("历史：上下翻动，回到最新一条时恢复草稿", () => {
		const editor = new LineEditor();
		editor.insert("第一条");
		editor.submit();
		editor.insert("第二条");
		editor.submit();

		editor.insert("还没发出去的草稿");
		editor.historyPrev();
		assert.equal(editor.text, "第二条");
		editor.historyPrev();
		assert.equal(editor.text, "第一条");
		editor.historyPrev();
		assert.equal(editor.text, "第一条");
		editor.historyNext();
		assert.equal(editor.text, "第二条");
		editor.historyNext();
		assert.equal(editor.text, "还没发出去的草稿");
		editor.historyNext();
		assert.equal(editor.text, "还没发出去的草稿");
	});

	it("连续两条相同的内容只记一次历史", () => {
		const editor = new LineEditor();
		editor.insert("同样的话");
		editor.submit();
		editor.insert("同样的话");
		editor.submit();
		editor.historyPrev();
		assert.equal(editor.text, "同样的话");
		editor.historyPrev();
		assert.equal(editor.text, "同样的话");
	});

	it("提交后内容清空", () => {
		const editor = new LineEditor();
		editor.insert("做点事");
		assert.equal(editor.submit(), "做点事");
		assert.equal(editor.text, "");
		assert.equal(editor.isEmpty, true);
	});

	it("空内容时显示灰色提示，光标停在提示符之后", () => {
		const editor = new LineEditor();
		const rendered = editor.render({ width: 20, prompt: [...PROMPT], placeholder: "说点什么" });
		assert.deepEqual(rendered.lines.map((line) => lineText(line)), ["› 说点什么"]);
		assert.deepEqual(rendered.cursor, { row: 0, col: 2 });
	});

	it("光标落在哪个字符上，哪一格就反显", () => {
		const editor = new LineEditor();
		editor.insert("ab");
		editor.moveLeft();
		const rendered = editor.render({ width: 20, prompt: [...PROMPT] });
		assert.deepEqual(rendered.lines[0][2], { text: "b", style: { reverse: true } });
		assert.deepEqual(rendered.cursor, { row: 0, col: 3 });
	});

	it("光标在末尾时补一格反显空格，位置仍然正确", () => {
		const editor = new LineEditor();
		editor.insert("ab");
		const rendered = editor.render({ width: 20, prompt: [...PROMPT] });
		assert.equal(lineText(rendered.lines[0]), "› ab ");
		assert.deepEqual(rendered.cursor, { row: 0, col: 4 });
	});

	it("内容超过一行时折行，续行与提示符对齐", () => {
		const editor = new LineEditor();
		editor.insert("一二三四五六七八九十");
		const rendered = editor.render({ width: 10, prompt: [{ text: "› " }] });
		// 提示符占两列，剩下的八列刚好放四个汉字；末尾的反显空格另占一列
		assert.deepEqual(rendered.lines.map((line) => lineText(line)), ["› 一二三四", "› 五六七八", "› 九十 "]);
		assert.deepEqual(rendered.cursor, { row: 2, col: 6 });
	});

	it("折行时光标位置跟着所在的显示行走", () => {
		const editor = new LineEditor();
		editor.insert("一二三四五六");
		editor.moveHome();
		editor.moveRight();
		const rendered = editor.render({ width: 6, prompt: [{ text: "› " }] });
		assert.deepEqual(rendered.cursor, { row: 0, col: 4 });
	});

	it("宽字符与 emoji 的显示宽度与光标位置一致", () => {
		const editor = new LineEditor();
		editor.insert("中文😀");
		const rendered = editor.render({ width: 20, prompt: [{ text: "› " }] });
		// 提示符两列 + 两个汉字四列 + 一个 emoji 两列，光标停在末尾的反显空格上
		assert.equal(displayWidth(lineText(rendered.lines[0])), 2 + 4 + 2 + 1);
		assert.deepEqual(rendered.cursor, { row: 0, col: 8 });
	});

	it("清空只清内容，历史还在", () => {
		const editor = new LineEditor();
		editor.insert("历史内容");
		editor.submit();
		editor.insert("临时");
		editor.clear();
		assert.equal(editor.text, "");
		editor.historyPrev();
		assert.equal(editor.text, "历史内容");
	});
});
