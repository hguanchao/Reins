import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KeyDecoder, type KeyEvent } from "../../../src/tui/input/keys.ts";

function names(events: readonly KeyEvent[]): string[] {
	return events.map((event) => {
		if (event.type === "key") return event.name;
		if (event.type === "focus") return event.focused ? "focus-in" : "focus-out";
		return `${event.type}:${event.text}`;
	});
}

describe("KeyDecoder", () => {
	it("普通字符合成一段文本", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("hello")), ["text:hello"]);
	});

	it("基本按键", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("\r")), ["enter"]);
		assert.deepEqual(names(decoder.push("\x7f")), ["backspace"]);
		assert.deepEqual(names(decoder.push("\x08")), ["backspace"]);
		assert.deepEqual(names(decoder.push("\t")), ["tab"]);
		assert.deepEqual(names(decoder.push("\x03")), ["ctrl-c"]);
		assert.deepEqual(names(decoder.push("\x04")), ["ctrl-d"]);
		assert.deepEqual(names(decoder.push("\x0c")), ["ctrl-l"]);
	});

	it("方向键与编辑键", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("\x1b[A\x1b[B\x1b[C\x1b[D")), ["up", "down", "right", "left"]);
		assert.deepEqual(names(decoder.push("\x1b[3~")), ["delete"]);
		assert.deepEqual(names(decoder.push("\x1b[H\x1b[F")), ["home", "end"]);
		assert.deepEqual(names(decoder.push("\x1b[1~\x1b[4~")), ["home", "end"]);
		assert.deepEqual(names(decoder.push("\x1b[7~\x1b[8~")), ["home", "end"]);
		assert.deepEqual(names(decoder.push("\x1bOA\x1bOB\x1bOC\x1bOD")), ["up", "down", "right", "left"]);
		assert.deepEqual(names(decoder.push("\x1bOH\x1bOF")), ["home", "end"]);
	});

	it("被切开的方向键要等齐了才发出来", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b"), []);
		assert.deepEqual(decoder.push("["), []);
		assert.deepEqual(names(decoder.push("A")), ["up"]);
	});

	it("孤立的 ESC 在收尾时算 Esc 键", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b"), []);
		assert.deepEqual(names(decoder.flush()), ["escape"]);
		// 没有残片时收尾什么都不做
		assert.deepEqual(decoder.flush(), []);
	});

	it("ESC 后面跟普通字符时按 Esc 加文本处理", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("\x1ba")), ["escape", "text:a"]);
	});

	it("焦点变化", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("\x1b[I")), ["focus-in"]);
		assert.deepEqual(names(decoder.push("\x1b[O")), ["focus-out"]);
	});

	it("括号粘贴的内容整段取出，里面的换行不是回车", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("\x1b[200~第一行\n第二行\x1b[201~")), ["paste:第一行\n第二行"]);
	});

	it("粘贴被切成多段时逐段吐出", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("\x1b[200~abc")), ["paste:abc"]);
		assert.deepEqual(names(decoder.push("def")), ["paste:def"]);
		assert.deepEqual(names(decoder.push("\x1b[201~")), []);
		// 粘贴结束后回到普通解析
		assert.deepEqual(names(decoder.push("x")), ["text:x"]);
	});

	it("认不出来的序列丢掉，不当成文本", () => {
		const decoder = new KeyDecoder();
		// 鼠标报告与终端状态回复
		assert.deepEqual(decoder.push("\x1b[<0;10;5M"), []);
		assert.deepEqual(decoder.push("\x1b]11;rgb:0000/0000/0000\x07"), []);
		assert.deepEqual(decoder.push("\x1b[?2004;1$y"), []);
		// 功能键没有绑定，同样丢掉
		assert.deepEqual(decoder.push("\x1b[15~"), []);
		// 但后续的文本照常解析
		assert.deepEqual(names(decoder.push("ok")), ["text:ok"]);
	});

	it("未结束的操作系统命令序列要等结束标记", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b]11;rgb:00"), []);
		assert.deepEqual(decoder.push("00/0000\x07"), []);
	});

	it("中文字符原样作为文本", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(names(decoder.push("中文")), ["text:中文"]);
		assert.deepEqual(names(decoder.push("中\x1b[A文")), ["text:中", "up", "text:文"]);
	});
});
