import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { userMessageAnchors } from "#web/chat/message-rail-model.ts";
import type { Line } from "#web/transcript/lines.ts";

/** 轨迹条目只回答两个问题：哪条提问、它在会话流里的原始下标。 */
describe("消息轨迹锚点", () => {
	it("只取用户消息，保留原始下标", () => {
		const lines: Line[] = [
			{ kind: "user", text: "先看登录" },
			{ kind: "thinking", text: "想想", open: false },
			{ kind: "assistant", text: "好", open: false },
			{ kind: "user", text: "再改测试" },
		];
		assert.deepEqual(userMessageAnchors(lines), [
			{ index: 0, text: "先看登录" },
			{ index: 3, text: "再改测试" },
		]);
	});

	it("换行与连续空白折成单个空格", () => {
		assert.deepEqual(userMessageAnchors([{ kind: "user", text: "  修一下\n\n然后  跑测试  " }]), [
			{ index: 0, text: "修一下 然后 跑测试" },
		]);
	});

	it("只有空白的提问保留为空串", () => {
		assert.deepEqual(userMessageAnchors([{ kind: "user", text: " \n " }]), [{ index: 0, text: "" }]);
	});

	it("没有用户消息时返回空列表", () => {
		assert.deepEqual(
			userMessageAnchors([
				{ kind: "assistant", text: "直接回答", open: false },
				{ kind: "notice", text: "提示", tone: "info" },
			]),
			[],
		);
	});
});
