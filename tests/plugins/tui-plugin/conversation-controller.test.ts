import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConversationController } from "../../../src/plugins/tui-plugin/conversation-controller.ts";
import { GUTTER_WIDTH, OUTER_PAD } from "../../../src/plugins/tui-plugin/layout.ts";
import { lineText } from "../../../src/tui/text/line.ts";

describe("主区控制器", () => {
	it("摊平会话、选中块并切换折叠", () => {
		const conversation = new ConversationController(40);
		conversation.userTurn("word ".repeat(30), 0);
		const rows = conversation.conversationRows(40, 8);
		assert.equal(rows.length, 8);
		const block = conversation.blocks[0];
		assert.ok(block);
		assert.equal(block.mode, "collapsed", "long message folds by default");

		const clickRow = block.start + conversation.topPad;
		assert.equal(conversation.clickBlock(clickRow), "selected");
		assert.equal(conversation.selectedBlockId, block.id);
		assert.equal(conversation.clickBlock(clickRow), "toggled");
		conversation.conversationRows(40, 8);
		assert.equal(conversation.blocks[0].mode, "expanded");
	});

	it("内容上下各留一行，翻离一端时留白里给出跟随指示", () => {
		const conversation = new ConversationController(60);
		for (let index = 0; index < 12; index += 1) conversation.userTurn(`turn ${index}`, index);

		const bottom = conversation.conversationRows(60, 8);
		assert.equal(conversation.topPad, 1);
		assert.equal(conversation.areaHeight, 8);
		assert.ok(lineText(bottom[0]).includes("▲"), "more content above");
		assert.equal(conversation.padActionAt(0), "top");
		assert.equal(conversation.padActionAt(7), undefined, "following: no down indicator");

		conversation.toTop();
		const top = conversation.conversationRows(60, 8);
		assert.ok(lineText(top[top.length - 1]).includes("▼"), "more content below");
		assert.equal(conversation.padActionAt(7), "bottom");
	});

	it("选中框右上角可以关闭选中", () => {
		const conversation = new ConversationController(40);
		conversation.userTurn("hello", 0);
		conversation.conversationRows(40, 8);
		const block = conversation.blocks[0];
		assert.ok(block);
		conversation.selectedBlockId = block.id;

		const entryWidth = 40 - GUTTER_WIDTH;
		const top = block.start - conversation.window.start + conversation.topPad - 1;
		const right = OUTER_PAD + entryWidth;
		assert.equal(conversation.selectionCloseAt(top, right, entryWidth), true);
		assert.equal(conversation.selectionCloseAt(top, right - 1, entryWidth), false);

		conversation.clearSelectedBlock();
		assert.equal(conversation.selectedBlockId, undefined);
	});

	it("轨道出现时不再画滚动条", () => {
		const conversation = new ConversationController(60);
		for (let index = 0; index < 8; index += 1) conversation.userTurn(`turn ${index} `.repeat(4), index);
		const rows = conversation.conversationRows(60, 6);

		assert.ok(conversation.turns.length >= 2, "rail is eligible");
		assert.equal(conversation.scrollbarShown, false);
		assert.ok(!rows.some((row) => lineText(row).endsWith("█")), "no scrollbar thumb");
	});

	it("拖选返回选区文本，块复制返回完整正文", () => {
		const conversation = new ConversationController(40);
		conversation.userTurn("hello", 0);
		conversation.conversationRows(40, 8);

		conversation.beginSelection({ line: 1, cell: 2 });
		assert.equal(conversation.updateSelection({ line: 1, cell: 7 }), true);
		assert.equal(conversation.finishSelection(), "hello");

		const block = conversation.blocks[0];
		assert.equal(conversation.blockText(block.id), "hello");
		assert.equal(conversation.blockMeta(block.id), undefined);
	});

	it("滚动改变可视窗口，回合跳转落在刻度行上", () => {
		const conversation = new ConversationController(40);
		for (let index = 0; index < 12; index += 1) conversation.userTurn(`turn ${index}`, index);
		conversation.conversationRows(40, 6);
		assert.ok(conversation.total > conversation.height);

		conversation.scrollBy(10);
		conversation.conversationRows(40, 6);
		assert.ok(conversation.window.start > 0);

		conversation.jumpTurn(-1);
		conversation.conversationRows(40, 6);
		assert.ok(conversation.window.start >= 0);
		assert.ok(!conversation.window.following);
	});
});
