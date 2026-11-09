import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	applyWindowAction,
	parseWindowAction,
	type WindowControlTarget,
} from "#desktop/window-controls.ts";

/** 只记录被调用的方法，动作翻译不该依赖真实的 Electron 窗口。 */
function fakeWindow(maximized: boolean): { target: WindowControlTarget; calls: readonly string[] } {
	const calls: string[] = [];
	const target: WindowControlTarget = {
		isMaximized: () => maximized,
		minimize: () => calls.push("minimize"),
		maximize: () => calls.push("maximize"),
		unmaximize: () => calls.push("unmaximize"),
		close: () => calls.push("close"),
	};
	return { target, calls };
}

describe("自绘窗控动作", () => {
	it("只收窄三种动作，未知值不执行", () => {
		assert.equal(parseWindowAction("minimize"), "minimize");
		assert.equal(parseWindowAction("toggle-maximize"), "toggle-maximize");
		assert.equal(parseWindowAction("close"), "close");
		assert.equal(parseWindowAction("quit"), undefined);
		assert.equal(parseWindowAction(undefined), undefined);
		assert.equal(parseWindowAction({ action: "close" }), undefined);
	});

	it("最小化与关闭各自落到单一动作", () => {
		const small = fakeWindow(false);
		applyWindowAction(small.target, "minimize");
		assert.deepEqual(small.calls, ["minimize"]);

		const shut = fakeWindow(true);
		applyWindowAction(shut.target, "close");
		assert.deepEqual(shut.calls, ["close"]);
	});

	it("最大化/还原按窗口当前状态二选一", () => {
		const normal = fakeWindow(false);
		applyWindowAction(normal.target, "toggle-maximize");
		assert.deepEqual(normal.calls, ["maximize"]);

		const big = fakeWindow(true);
		applyWindowAction(big.target, "toggle-maximize");
		assert.deepEqual(big.calls, ["unmaximize"]);
	});
});
