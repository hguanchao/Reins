import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startSpinner, stopSpinner, clearStatus, scheduleStatusClear, setStatus } from "#src/tui/runtime/status.ts";
import { STATUS_CLEAR_MS, STATUS_ERROR_CLEAR_MS, SPINNER_INTERVAL_MS, UNDO_HINT_MS } from "#src/tui/runtime/constants.ts";
import type { ActiveTurn, TuiState } from "#src/tui/runtime/types.ts";

function stateOf(): TuiState {
	return {
		statusText: undefined,
		statusTone: undefined,
		statusClearTimer: undefined,
		statusElapsedMs: 0,
		statusTokens: 0,
		statusPhaseStartedAt: 0,
		copyNotice: undefined,
		copyNoticeTimer: undefined,
	} as TuiState;
}

describe("状态行自动清除", () => {
	it("notice 按默认 1.5 秒自动消失", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const state = stateOf();
		let rendered = 0;
		setStatus(state, "hint", "notice");
		scheduleStatusClear(state, () => {
			rendered += 1;
		});
		t.mock.timers.tick(STATUS_CLEAR_MS - 1);
		assert.equal(state.statusText, "hint");
		t.mock.timers.tick(1);
		assert.equal(state.statusText, undefined);
		assert.equal(rendered, 1);
	});

	it("notice 可以指定更长的停留时间", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const state = stateOf();
		setStatus(state, "cleared", "notice");
		scheduleStatusClear(state, () => {}, UNDO_HINT_MS);
		t.mock.timers.tick(STATUS_CLEAR_MS);
		assert.equal(state.statusText, "cleared");
		t.mock.timers.tick(UNDO_HINT_MS - STATUS_CLEAR_MS);
		assert.equal(state.statusText, undefined);
	});

	it("错误按更长的窗口消失，不会 1.5 秒就被清掉", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const state = stateOf();
		setStatus(state, "boom", "error");
		scheduleStatusClear(state, () => {});
		t.mock.timers.tick(STATUS_CLEAR_MS);
		assert.equal(state.statusText, "boom");
		t.mock.timers.tick(STATUS_ERROR_CLEAR_MS - STATUS_CLEAR_MS);
		assert.equal(state.statusText, undefined);
	});

	it("警告同样用长窗口", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const state = stateOf();
		setStatus(state, "careful", "warning");
		scheduleStatusClear(state, () => {});
		t.mock.timers.tick(STATUS_CLEAR_MS);
		assert.equal(state.statusText, "careful");
		t.mock.timers.tick(STATUS_ERROR_CLEAR_MS - STATUS_CLEAR_MS);
		assert.equal(state.statusText, undefined);
	});

	it("新状态作废上一条登记的清除计时", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const state = stateOf();
		setStatus(state, "first", "notice");
		scheduleStatusClear(state, () => {});
		// 第二条不登记清除：第一条的计时不能把它清掉（回合中途的附加图片就会这样）
		setStatus(state, "second");
		t.mock.timers.tick(STATUS_CLEAR_MS * 2);
		assert.equal(state.statusText, "second");
	});

	it("clearStatus 立即清空并复位计时元数据", () => {
		const state = stateOf();
		setStatus(state, "phase");
		state.statusElapsedMs = 3_000;
		state.statusTokens = 42;
		clearStatus(state);
		assert.equal(state.statusText, undefined);
		assert.equal(state.statusTone, undefined);
		assert.equal(state.statusElapsedMs, 0);
		assert.equal(state.statusTokens, 0);
	});

	it("还有工具在跑时每个刷新帧都把对话流标脏，耗时才按 0.1s 跳动", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const state = stateOf();
		state.activeTurn = {
			lines: [{ kind: "tool", name: "Bash", detail: "npm test", startedAt: Date.now() }],
		} as ActiveTurn;
		state.transcriptDirty = false;
		startSpinner(state, () => {}, () => {});
		t.mock.timers.tick(SPINNER_INTERVAL_MS);
		assert.equal(state.transcriptDirty, true);
		stopSpinner(state);
	});

	it("没有工具在跑时不因耗时标脏对话流", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const state = stateOf();
		state.activeTurn = { lines: [] } as unknown as ActiveTurn;
		state.transcriptDirty = false;
		startSpinner(state, () => {}, () => {});
		t.mock.timers.tick(SPINNER_INTERVAL_MS);
		assert.equal(state.transcriptDirty, false);
		stopSpinner(state);
	});

	it("思考进行中每个刷新帧都标脏，标题耗时才按 0.1s 跳动", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const state = stateOf();
		state.activeTurn = {
			lines: [],
			thinkingBlock: { kind: "thinkingBlock", header: "", body: [], partial: "", running: true, expanded: false },
			thinkingStartedAt: Date.now(),
		} as unknown as ActiveTurn;
		state.transcriptDirty = false;
		startSpinner(state, () => {}, () => {});
		t.mock.timers.tick(SPINNER_INTERVAL_MS);
		assert.equal(state.transcriptDirty, true);
		stopSpinner(state);
	});

	it("任务卡运行中每个刷新帧都标脏，卡片耗时才按 0.1s 跳动", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const state = stateOf();
		state.activeTurn = { lines: [] } as unknown as ActiveTurn;
		state.currentTodo = {
			running: true,
			items: [{ content: "a", status: "in_progress" }],
			taskStartedAt: Date.now(),
		} as unknown as TuiState["currentTodo"];
		state.transcriptDirty = false;
		startSpinner(state, () => {}, () => {});
		t.mock.timers.tick(SPINNER_INTERVAL_MS);
		assert.equal(state.transcriptDirty, true);
		stopSpinner(state);
	});
});
