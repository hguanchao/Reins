import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { interactiveText } from "../../../src/tui/input/dispatch.ts";
import { approvalKey, pastingAfter, stripPasteContent } from "../../../src/tui/input/keys.ts";

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
