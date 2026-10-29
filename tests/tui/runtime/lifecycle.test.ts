import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXIT_SIGNALS, cleanup } from "../../../src/tui/runtime/lifecycle.ts";

/** 只填 cleanup 真正会碰到的字段；其余用不到，交给类型断言。 */
function stateOf(overrides: Record<string, unknown> = {}) {
	let finished = 0;
	const state = {
		finished: false,
		activeTurn: undefined,
		exitTimer: undefined,
		spinnerTimer: undefined,
		jobTimer: undefined,
		statusClearTimer: undefined,
		copyNoticeTimer: undefined,
		unsubscribeJobs: () => {},
		stdout: { off: () => {}, write: () => {} },
		stdin: { off: () => {}, setRawMode: () => {}, pause: () => {} },
		finish: () => {
			finished += 1;
		},
		...overrides,
	};
	return { state, finishCount: () => finished };
}

const DEPS = { render: () => {}, onData: () => {}, onInterrupt: () => {} };

describe("TUI 收尾", () => {
	it("终止信号覆盖 Ctrl+C、kill 与关窗口", () => {
		assert.deepEqual([...EXIT_SIGNALS], ["SIGINT", "SIGTERM", "SIGHUP"]);
	});

	it("收尾中途抛错也要让 runTui 落定", () => {
		const { state, finishCount } = stateOf({
			// 插件在 shutdown 里抛错：不收进 finally 的话 finish 永远不会执行
			unsubscribeJobs: () => {
				throw new Error("boom");
			},
		});

		assert.throws(() => cleanup(state as never, { approval: undefined, jobs: undefined } as never, DEPS), /boom/);
		assert.equal(finishCount(), 1);
	});

	it("重复收尾只落定一次", () => {
		const { state, finishCount } = stateOf();
		cleanup(state as never, { approval: undefined, jobs: undefined } as never, DEPS);
		cleanup(state as never, { approval: undefined, jobs: undefined } as never, DEPS);
		assert.equal(finishCount(), 1);
	});

	it("收尾时中止正在运行的审查", () => {
		let aborted = false;
		const { state } = stateOf({
			reviewAbort: {
				abort: () => {
					aborted = true;
				},
			},
		});

		cleanup(state as never, { approval: undefined, jobs: undefined } as never, DEPS);
		assert.equal(aborted, true);
	});
});
