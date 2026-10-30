import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { copyText } from "../../../src/tui/runtime/copy.ts";
import type { TuiHost, TuiState } from "../../../src/tui/runtime/types.ts";

/** 最小宿主：剪贴板必成功，渲染计数只用于确认刷新发生。 */
function fakeHost(state: TuiState): TuiHost & { readonly renders: number } {
	let renders = 0;
	return {
		state,
		renders: 0 as unknown as number,
		options: { clipboard: { copy: async () => true } },
		setStatus: () => {},
		scheduleStatusClear: () => {},
		render: () => {
			renders += 1;
		},
	} as unknown as TuiHost & { readonly renders: number };
}

function freshState(): TuiState {
	return {
		statusText: undefined,
		statusTone: undefined,
		statusClearTimer: undefined,
		copyNotice: undefined,
		copyNoticeTimer: undefined,
	} as unknown as TuiState;
}

describe("复制提示的单一来源", () => {
	it("状态行空闲时复制：提示只占 token 位，不再写左侧状态文字", async (t) => {
		const state = freshState();
		const host = fakeHost(state);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		await copyText(host, "hello");
		assert.equal(state.copyNotice, "Copied!");
		assert.equal(state.statusText, undefined);
	});

	it("连续复制不产生双提示：上一次的左侧残留被清掉", async (t) => {
		const state = freshState();
		const host = fakeHost(state);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		// 模拟上一次复制留下的左侧提示（旧实现的残留形态）
		state.statusText = "Copied!";
		await copyText(host, "second");
		assert.equal(state.copyNotice, "Copied!");
		assert.equal(state.statusText, undefined);
	});

	it("上一次状态清理的计时器不再吞掉本次提示", async (t) => {
		const state = freshState();
		const host = fakeHost(state);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		// 模拟回合状态带着一个未到期的自动清理计时器
		state.statusText = "Working";
		state.statusTone = undefined;
		state.statusClearTimer = setTimeout(() => {}, 60_000) as unknown as ReturnType<typeof setTimeout>;
		await copyText(host, "hello");
		assert.equal(state.copyNotice, "Copied!");
		// 旧计时器已被取消，提示不会被它提前清掉
		assert.equal(state.statusClearTimer, undefined);
		assert.notEqual(state.copyNoticeTimer, undefined);
	});
});
