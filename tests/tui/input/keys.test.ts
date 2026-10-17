import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KeyDecoder, type KeyEvent } from "../../../src/tui/input/keys.ts";

function keys(events: readonly KeyEvent[]): string[] {
	return events.map((event) => (event.type === "key" ? event.name : event.type));
}

describe("按键解码", () => {
	it("普通文本整体解码", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("hello"), [{ type: "text", text: "hello" }]);
	});

	it("回车、退格、Tab 认成按键", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\r x\x7f\t"), [
			{ type: "key", name: "enter" },
			{ type: "text", text: " x" },
			{ type: "key", name: "backspace" },
			{ type: "key", name: "tab" },
		]);
	});

	it("绑定的控制字符认成 ctrl-*，没绑定的直接丢掉", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x03"), [{ type: "key", name: "ctrl-c" }]);
		// \x02 没有绑定：直接丢掉，两侧的文本照常解码
		assert.deepEqual(decoder.push("a\x02b"), [{ type: "text", text: "a" }, { type: "text", text: "b" }]);
	});

	it("方向键与功能键的 CSI 序列", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(keys(decoder.push("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F")), [
			"up",
			"down",
			"right",
			"left",
			"home",
			"end",
		]);
		assert.deepEqual(keys(decoder.push("\x1b[3~\x1b[5~\x1b[6~")), ["delete", "pageup", "pagedown"]);
	});

	it("应用光标键模式（SS3）也认", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(keys(decoder.push("\x1bOA\x1bOC")), ["up", "right"]);
	});

	it("序列被切在两次读取之间也能拼上", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b"), []);
		assert.deepEqual(decoder.push("["), []);
		assert.deepEqual(keys(decoder.push("A")), ["up"]);
	});

	it("孤立的 ESC 在 flush 时交给调用方按 Esc 处理", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b"), []);
		assert.deepEqual(keys(decoder.flush()), ["escape"]);
	});

	it("ESC 后跟普通字符：ESC 本身是 Esc 键，字符另算", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1bq"), [
			{ type: "key", name: "escape" },
			{ type: "text", text: "q" },
		]);
	});

	it("括号粘贴：内容作为 paste 事件，换行不是回车", () => {
		const decoder = new KeyDecoder();
		const events = decoder.push("\x1b[200~line1\nline2\x1b[201~");
		assert.deepEqual(events, [{ type: "paste", text: "line1\nline2" }]);
	});

	it("粘贴内容和结束标记被切在两次数据之间", () => {
		const decoder = new KeyDecoder();
		// 结束标记只来了一半：已确认是正文的先交出去，末尾像标记开头的几个字符压住
		assert.deepEqual(decoder.push("\x1b[200~abc\x1b[20"), [{ type: "paste", text: "abc" }]);
		assert.deepEqual(decoder.push("1~"), []);
	});

	it("焦点事件", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b[I"), [{ type: "focus", focused: true }]);
		assert.deepEqual(decoder.push("\x1b[O"), [{ type: "focus", focused: false }]);
	});

	it("SGR 鼠标滚轮：64 上滚、65 下滚", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b[<64;12;3M"), [{ type: "wheel", direction: "up" }]);
		assert.deepEqual(decoder.push("\x1b[<65;1;1M"), [{ type: "wheel", direction: "down" }]);
	});

	it("其余鼠标按钮（m 松开、左键等）丢弃", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b[<0;1;1M"), []);
		assert.deepEqual(decoder.push("\x1b[<64;1;1m"), []);
	});

	it("终端状态回复（OSC）整段丢弃", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(decoder.push("\x1b]10;rgb:1/1/1\x07"), []);
		assert.deepEqual(decoder.push("\x1b]10;rgb:1/1/1\x1b\\"), []);
		assert.deepEqual(decoder.push("ok"), [{ type: "text", text: "ok" }]);
	});

	it("退格的 0x08 形式也认", () => {
		const decoder = new KeyDecoder();
		assert.deepEqual(keys(decoder.push("\x08")), ["backspace"]);
	});
});
