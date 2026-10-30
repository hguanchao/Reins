import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { interactiveText } from "#src/tui/input/dispatch.ts";
import {
	approvalKey,
	decodeKittyKeys,
	editInput,
	pastingAfter,
	shiftTabKey,
	stripPasteContent,
} from "#src/tui/input/keys.ts";

describe("粘贴区间", () => {
	it("单块内起止标记被剥掉", () => {
		assert.equal(stripPasteContent("\x1b[200~rm -rf /\x1b[201~"), "");
		assert.equal(stripPasteContent("a\x1b[200~b\x1b[201~c"), "ac");
	});

	it("只有起始标记时剥到块尾", () => {
		assert.equal(stripPasteContent("\x1b[200~rm -rf /"), "");
	});

	it("状态按标记出现顺序翻转", () => {
		assert.equal(pastingAfter("\x1b[200~abc", false), true);
		assert.equal(pastingAfter("abc\x1b[201~", true), false);
		// 同块内既有起又有止，净效果为零
		assert.equal(pastingAfter("\x1b[200~abc\x1b[201~", false), false);
		// 没有标记时保持进入本块前的状态
		assert.equal(pastingAfter("abc", true), true);
		assert.equal(pastingAfter("abc", false), false);
	});

	it("跨块粘贴的后续块整块被丢弃，不产生按键", () => {
		// 第一块带起始标记、没有结束标记
		assert.equal(interactiveText("\x1b[200~first line", false), "");
		assert.equal(pastingAfter("\x1b[200~first line", false), true);
		// 后续块没有起始标记：修好之前这里会原样返回，其中的 \r 被审批卡当成回车
		assert.equal(interactiveText("second line\r", true), "");
		// 结束标记之后的按键才是真的按键
		assert.equal(interactiveText("second line\x1b[201~\r", true), "\r");
	});

	it("不在粘贴区间时正常返回按键", () => {
		assert.equal(interactiveText("\r", false), "\r");
		assert.equal(interactiveText("\x1b[A", false), "\x1b[A");
	});
});

describe("审批按键", () => {
	it("单键给出对应结论", () => {
		assert.equal(approvalKey("y", true), "once");
		assert.equal(approvalKey("Y", true), "once");
		assert.equal(approvalKey("a", true), "always");
		assert.equal(approvalKey("n", true), "deny");
		assert.equal(approvalKey("\r", true), "enter");
		assert.equal(approvalKey("\x1b", true), "escape");
		assert.equal(approvalKey("\x1b[D", true), "left");
		assert.equal(approvalKey("\x1b[C", true), "right");
	});

	it("多键块与含字母的文本不产生结论", () => {
		// 使用者正在打自己的下一句话时审批卡弹出：整段文字不能被当成批准
		assert.equal(approvalKey("add a test", true), undefined);
		assert.equal(approvalKey("any", true), undefined);
		assert.equal(approvalKey("ny", true), undefined);
		assert.equal(approvalKey("y\r", true), undefined);
		assert.equal(approvalKey("yes", true), undefined);
	});

	it("没有可记住的范围时 a 不生效", () => {
		assert.equal(approvalKey("a", false), undefined);
	});
});

describe("多行输入光标", () => {
	it("Shift+Enter 插入换行而不是提交", () => {
		for (const sequence of ["\x1b[13;2u", "\x1b[27;2;13~"]) {
			const edit = editInput("ab", 2, sequence, false);
			assert.equal(edit.text, "ab\n");
			assert.equal(edit.cursor, 3);
			assert.equal(edit.submit, false);
		}
	});

	it("Alt+Enter 不再插入换行，也不会退化成提交", () => {
		for (const sequence of ["\x1b\r", "\x1b\n"]) {
			const edit = editInput("ab", 2, sequence, false);
			assert.equal(edit.text, "ab");
			assert.equal(edit.submit, false);
		}
	});

	it("普通回车仍然提交", () => {
		assert.equal(editInput("ab", 2, "\r", false).submit, true);
	});
});

describe("kitty 键盘协议解码", () => {
	it("Ctrl 快捷键还原成控制字符", () => {
		assert.equal(decodeKittyKeys("\x1b[99;5u", false), "\x03");
		assert.equal(decodeKittyKeys("\x1b[101;5u", false), "\x05");
		assert.equal(decodeKittyKeys("\x1b[103;5u", false), "\x07");
		assert.equal(decodeKittyKeys("\x1b[111;5u", false), "\x0f");
		assert.equal(decodeKittyKeys("\x1b[118;5u", false), "\x16");
	});

	it("CapsLock/NumLock 位不影响快捷键判定", () => {
		// 修饰键值 = 1 + ctrl(4) + caps_lock(64)
		assert.equal(decodeKittyKeys("\x1b[99;69u", false), "\x03");
	});

	it("Alt+字母还原成 ESC 前缀", () => {
		assert.equal(decodeKittyKeys("\x1b[118;3u", false), "\x1bv");
		assert.equal(decodeKittyKeys("\x1b[118;4u", false), "\x1bV");
	});

	it("Esc 与 Shift+Esc 都还原成单个 ESC", () => {
		assert.equal(decodeKittyKeys("\x1b[27u", false), "\x1b");
		assert.equal(decodeKittyKeys("\x1b[27;2u", false), "\x1b");
	});

	it("Shift+Enter 与 Shift+Tab 保持原序列交给后续解析", () => {
		assert.equal(decodeKittyKeys("\x1b[13;2u", false), "\x1b[13;2u");
		assert.equal(decodeKittyKeys("\x1b[9;2u", false), "\x1b[9;2u");
		assert.equal(shiftTabKey(decodeKittyKeys("\x1b[9;2u", false)), true);
	});

	it("Alt+Enter 与 Ctrl+Enter 被吞掉，不提交也不换行", () => {
		assert.equal(decodeKittyKeys("\x1b[13;3u", false), "");
		assert.equal(decodeKittyKeys("\x1b[13;5u", false), "");
	});

	it("小键盘按键还原成正文与传统序列", () => {
		assert.equal(decodeKittyKeys("\x1b[57399u", false), "0");
		assert.equal(decodeKittyKeys("\x1b[57408u", false), "9");
		assert.equal(decodeKittyKeys("\x1b[57414u", false), "\r");
		assert.equal(decodeKittyKeys("\x1b[57417u", false), "\x1b[D");
		assert.equal(decodeKittyKeys("\x1b[57426u", false), "\x1b[3~");
	});

	it("传统序列与普通文本原样通过", () => {
		assert.equal(decodeKittyKeys("abc\r\t", false), "abc\r\t");
		assert.equal(decodeKittyKeys("\x1b[A\x1b[1;5H", false), "\x1b[A\x1b[1;5H");
	});

	it("粘贴区间里的 CSI-u 是正文，不能被当成按键", () => {
		assert.equal(
			decodeKittyKeys("\x1b[200~\x1b[99;5u\x1b[201~", false),
			"\x1b[200~\x1b[99;5u\x1b[201~",
		);
		// 跨块粘贴：起始标记在前一块，当前块整块都是正文
		assert.equal(decodeKittyKeys("\x1b[99;5u\x1b[201~", true), "\x1b[99;5u\x1b[201~");
	});

	it("松开事件直接丢弃", () => {
		assert.equal(decodeKittyKeys("\x1b[99;5:3u", false), "");
	});
});
