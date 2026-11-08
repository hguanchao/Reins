import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	pickActiveAnchor,
	truncateRailText,
	userMessageAnchors,
	visibleTicks,
	type AnchorRect,
} from "#web/chat/message-rail-model.ts";
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

describe("活动提问判定", () => {
	const viewport = { top: 0, bottom: 100 };

	it("没有可见提问时不判定", () => {
		assert.equal(pickActiveAnchor([], viewport, false), undefined);
		assert.equal(
			pickActiveAnchor(
				[
					{ index: 1, top: -80, bottom: -20 },
					{ index: 2, top: 150, bottom: 200 },
				],
				viewport,
				false,
			),
			undefined,
		);
	});

	it("取视口上缘越过判定线的最近一条", () => {
		const rects: AnchorRect[] = [
			{ index: 1, top: 0, bottom: 30 },
			{ index: 2, top: 50, bottom: 80 },
		];
		assert.equal(pickActiveAnchor(rects, viewport, false), 1);
	});

	it("多条越线时取最靠下的一条", () => {
		const rects: AnchorRect[] = [
			{ index: 1, top: -20, bottom: 30 },
			{ index: 2, top: 5, bottom: 60 },
		];
		assert.equal(pickActiveAnchor(rects, viewport, false), 2);
	});

	it("上方一条都没有越线时取第一条可见的", () => {
		assert.equal(
			pickActiveAnchor(
				[
					{ index: 1, top: -80, bottom: -5 },
					{ index: 2, top: 30, bottom: 60 },
					{ index: 3, top: 70, bottom: 90 },
				],
				viewport,
				false,
			),
			2,
		);
	});

	it("滚到底时取视口内最靠下的一条", () => {
		const rects: AnchorRect[] = [
			{ index: 1, top: 0, bottom: 30 },
			{ index: 2, top: 50, bottom: 80 },
		];
		assert.equal(pickActiveAnchor(rects, viewport, true), 2);
	});
});

describe("刻度条取样", () => {
	const anchors = Array.from({ length: 10 }, (_, index) => ({ index: index * 2, text: `提问 ${index}` }));

	it("条数未超上限时原样返回", () => {
		assert.deepEqual(visibleTicks(anchors, 4, 20), anchors);
	});

	it("超过上限时围绕当前提问取窗口", () => {
		const ticks = visibleTicks(anchors, 10, 4);
		assert.equal(ticks.length, 4);
		assert.deepEqual(
			ticks.map((tick) => tick.index),
			[6, 8, 10, 12],
		);
	});

	it("窗口贴边时向内收，不越过首尾", () => {
		assert.deepEqual(
			visibleTicks(anchors, 0, 4).map((tick) => tick.index),
			[0, 2, 4, 6],
		);
		assert.deepEqual(
			visibleTicks(anchors, 18, 4).map((tick) => tick.index),
			[12, 14, 16, 18],
		);
	});
});

describe("轨迹文本", () => {
	it("展示文本超长截断并补省略号", () => {
		assert.equal(truncateRailText("abcdef", 10), "abcdef");
		assert.equal(truncateRailText("abcdef", 3), "abc…");
	});
});
