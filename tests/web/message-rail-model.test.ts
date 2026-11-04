import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	compactScrollTopFor,
	estimateRailTextWidth,
	pickActiveAnchor,
	planOpenScroll,
	railMetrics,
	rowCenterY,
	selectRailSizerTexts,
	tickCenterY,
	truncateRailText,
	userMessageAnchors,
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

describe("消息轨迹几何", () => {
	it("没有提问时不给出度量", () => {
		assert.equal(railMetrics(0), undefined);
	});

	it("少量提问：刻度带与列表都不超高，刻度带在列表内垂直居中", () => {
		const metrics = railMetrics(10);
		assert.deepEqual(metrics, {
			outerHeight: 294,
			compactHeight: 160,
			compactContentHeight: 160,
			compactOffset: 67,
			rowsHeight: 294,
			closedInsetY: 67,
			openInsetY: 0,
			expandedHeight: 294,
		});
	});

	it("大量提问：展开高度封顶，收起刻度条封顶并允许列表滚动", () => {
		const metrics = railMetrics(100);
		assert.deepEqual(metrics, {
			outerHeight: 412,
			compactHeight: 412,
			compactContentHeight: 1420,
			compactOffset: 0,
			rowsHeight: 2814,
			closedInsetY: 0,
			openInsetY: 6,
			expandedHeight: 400,
		});
	});

	it("两种布局的条目中心都由条数等距推出", () => {
		const metrics = railMetrics(10);
		assert.ok(metrics !== undefined);
		assert.equal(tickCenterY(metrics, 0), 84);
		assert.equal(tickCenterY(metrics, 9), 210);
		assert.equal(rowCenterY(0), 21);
		assert.equal(rowCenterY(3), 105);
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

	it("越线的只有视口内的提问；上方一条都没有时取第一条可见的", () => {
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

describe("展开滚动计划", () => {
	it("让当前提问在展开后停留在原屏幕位置", () => {
		const plan = planOpenScroll({ activeIndex: 3, activeScreenY: 50, compactScrollTop: 0, maxScroll: 1000 });
		assert.deepEqual(plan, { scrollTop: 55, visualOffset: -55 });
	});

	it("目标滚动位受列表可滚区间约束", () => {
		const plan = planOpenScroll({ activeIndex: 3, activeScreenY: 50, compactScrollTop: 10, maxScroll: 30 });
		assert.deepEqual(plan, { scrollTop: 30, visualOffset: -20 });
	});

	it("当前提问本就靠近顶部时不产生负滚动", () => {
		const plan = planOpenScroll({ activeIndex: 3, activeScreenY: 500, compactScrollTop: 0, maxScroll: 1000 });
		assert.deepEqual(plan, { scrollTop: 0, visualOffset: 0 });
	});
});

describe("收起滚动居中", () => {
	it("内容超高时让当前刻度居中", () => {
		assert.equal(
			compactScrollTopFor({
				activeIndex: 50,
				compactOffset: 0,
				current: 0,
				clientHeight: 400,
				contentHeight: 1420,
			}),
			517,
		);
	});

	it("已经居中（±1px）时维持原位", () => {
		assert.equal(
			compactScrollTopFor({
				activeIndex: 0,
				compactOffset: 67,
				current: 83,
				clientHeight: 400,
				contentHeight: 1420,
			}),
			83,
		);
	});

	it("内容不超高时没有可滚空间", () => {
		assert.equal(
			compactScrollTopFor({
				activeIndex: 9,
				compactOffset: 67,
				current: 300,
				clientHeight: 400,
				contentHeight: 160,
			}),
			0,
		);
	});
});

describe("轨迹文本", () => {
	it("展示文本超长截断并补省略号", () => {
		assert.equal(truncateRailText("abcdef", 10), "abcdef");
		assert.equal(truncateRailText("abcdef", 3), "abc…");
	});

	it("宽度估算把宽字符记作 2", () => {
		assert.equal(estimateRailTextWidth("ab中"), 4);
	});

	it("量宽样本按估算宽度取最宽的若干条，且先按上限截断", () => {
		assert.deepEqual(selectRailSizerTexts(["a".repeat(200), "中".repeat(80), "b"], 2, 120), [
			"中".repeat(80),
			`${"a".repeat(120)}…`,
		]);
		assert.deepEqual(selectRailSizerTexts(["a".repeat(200)], 5, 120), [`${"a".repeat(120)}…`]);
	});
});
