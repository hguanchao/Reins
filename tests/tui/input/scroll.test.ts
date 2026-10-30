import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	applyDragScroll,
	applyWheelScroll,
	handleScrollKey,
	handleToggleKey,
	trackClick,
} from "#src/tui/input/scroll.ts";
import { DOUBLE_CLICK_MS, WHEEL_STEP } from "#src/tui/runtime/constants.ts";
import type { TuiHost, TuiState } from "#src/tui/runtime/types.ts";
import type { TranscriptTool } from "#src/tui/transcript.ts";
import { toggleLastExpandable } from "#src/tui/transcript.ts";

function stateOf(overrides: Partial<TuiState> = {}): TuiState {
	return {
		scrollTop: 0,
		follow: true,
		lastClick: undefined,
		turns: [],
		...overrides,
	} as TuiState;
}

function hostOf(maxScroll: number): TuiHost {
	return { maxScroll: () => maxScroll } as TuiHost;
}

describe("点击识别", () => {
	it("同一点在时间窗口内第二次按下算双击", () => {
		const state = stateOf();
		const now = Date.now();
		assert.equal(trackClick(state, { press: true, button: 0, row: 3, column: 5 }), false);
		state.lastClick = { at: now - 10, row: 3, column: 5 };
		assert.equal(trackClick(state, { press: true, button: 0, row: 3, column: 5 }), true);
	});

	it("超过窗口或换了位置都不算双击", () => {
		const state = stateOf({ lastClick: { at: Date.now() - DOUBLE_CLICK_MS - 1, row: 3, column: 5 } });
		assert.equal(trackClick(state, { press: true, button: 0, row: 3, column: 5 }), false);

		const other = stateOf({ lastClick: { at: Date.now(), row: 9, column: 5 } });
		assert.equal(trackClick(other, { press: true, button: 0, row: 3, column: 5 }), false);
	});
});

describe("滚轮与拖动", () => {
	it("滚轮按固定步数移动并夹在上下界内", () => {
		const state = stateOf({ scrollTop: 0 });
		const host = hostOf(10);
		assert.equal(applyWheelScroll(host, state, 1), true);
		assert.equal(state.scrollTop, WHEEL_STEP);
		assert.equal(state.follow, false);

		applyWheelScroll(host, state, 100);
		assert.equal(state.scrollTop, 10);
		assert.equal(state.follow, true);
	});

	it("零格不移动", () => {
		const state = stateOf({ scrollTop: 4 });
		assert.equal(applyWheelScroll(hostOf(10), state, 0), false);
		assert.equal(state.scrollTop, 4);
	});

	it("拖动到最底行会打开跟随", () => {
		const state = stateOf();
		assert.equal(applyDragScroll(hostOf(10), state, 1_000, 5), true);
		assert.equal(state.follow, true);
	});
});

describe("滚动键", () => {
	it("PageUp/PageDown 按主区域高度翻页", () => {
		const state = stateOf({ scrollTop: 20 });
		const host = hostOf(30);
		assert.equal(handleScrollKey(host, state, "\x1b[5~", 5), true);
		assert.equal(state.scrollTop, 15);

		assert.equal(handleScrollKey(host, state, "\x1b[6~", 5), true);
		assert.equal(state.scrollTop, 20);
	});

	it("Ctrl+Home 回到顶部", () => {
		const state = stateOf({ scrollTop: 7 });
		assert.equal(handleScrollKey(hostOf(10), state, "\x1b[1;5H", 5), true);
		assert.equal(state.scrollTop, 0);
	});

	it("已经到顶时 PageUp 与 Ctrl+Home 不取消跟随", () => {
		const fits = stateOf({ scrollTop: 0, follow: true });
		assert.equal(handleScrollKey(hostOf(0), fits, "\x1b[5~", 5), true);
		assert.equal(fits.follow, true);
		assert.equal(handleScrollKey(hostOf(0), fits, "\x1b[1;5H", 5), true);
		assert.equal(fits.follow, true);

		// 内容超出屏幕时回到顶部才是「离开底部」，跟随要关掉
		const overflowing = stateOf({ scrollTop: 0, follow: true });
		assert.equal(handleScrollKey(hostOf(30), overflowing, "\x1b[5~", 5), true);
		assert.equal(overflowing.follow, false);
	});

	it("其它按键不消费", () => {
		assert.equal(handleScrollKey(hostOf(10), stateOf(), "a", 5), false);
	});
});

describe("展开键", () => {
	it("没有可展开目标时也消费按键", () => {
		assert.equal(handleToggleKey(stateOf(), "\x05"), true);
		assert.equal(handleToggleKey(stateOf(), "\x0f"), true);
		assert.equal(handleToggleKey(stateOf(), "a"), false);
	});

	it("Ctrl+O 记下被展开的工具供 Ctrl+G 定位", () => {
		const tool: TranscriptTool = { kind: "tool", name: "read", detail: "a", result: "ok" };
		const state = stateOf({ turns: [{ prompt: "p", response: [tool] }] });
		assert.equal(handleToggleKey(state, "\x0f"), true);
		assert.equal(state.viewerTool, tool);

		// 收起同一条工具时目标不变：Ctrl+G 仍然指向使用者最近摆弄的那一行
		assert.equal(handleToggleKey(state, "\x0f"), true);
		assert.equal(state.viewerTool, tool);
	});

	it("有目标时改动对话流并关闭跟随", () => {
		const tool: TranscriptTool = { kind: "tool", name: "read", detail: "a", result: "ok" };
		const state = stateOf({ turns: [{ prompt: "p", response: [tool] }] });
		assert.equal(handleToggleKey(state, ""), true);
		assert.equal(tool.resultExpanded, true);
		assert.equal(state.follow, false);

		const thinking = {
			kind: "thinkingBlock" as const,
			header: "hmm",
			body: [],
			partial: "",
			running: false,
			expanded: false,
		};
		const thinkingState = stateOf({ turns: [{ prompt: "p", response: [thinking] }] });
		assert.equal(handleToggleKey(thinkingState, ""), true);
		assert.equal(thinking.expanded, true);
		assert.equal(toggleLastExpandable(thinkingState.turns), true);
	});
});
