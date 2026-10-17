import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConversationController } from "../../../src/plugins/tui-plugin/conversation-controller.ts";

describe("主区控制器", () => {
	it("摊平会话、选中块并切换折叠", () => {
		const conversation = new ConversationController(40);
		conversation.userTurn("word ".repeat(30), 0);
		const rows = conversation.conversationRows(40, 8);
		assert.equal(rows.length, 8);
		const block = conversation.blocks[0];
		assert.ok(block);

		assert.equal(conversation.clickBlock(block.start), "selected");
		assert.equal(conversation.selectedBlockId, block.id);
		assert.equal(conversation.clickBlock(block.start), "toggled");
		conversation.conversationRows(40, 8);
		assert.equal(conversation.blocks[0].mode, "collapsed");
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
