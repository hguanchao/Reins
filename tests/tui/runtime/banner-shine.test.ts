import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startBannerShine, stopBannerShine } from "../../../src/tui/runtime/banner-shine.ts";
import { createState } from "../../../src/tui/runtime/state.ts";
import { BANNER_FRAME_MS, BANNER_SWEEP_MS } from "../../../src/tui/view/banner.ts";
import { FakeInput, FakeOutput, FOOTER_INFO } from "../support/harness.ts";

function newState(history = false): ReturnType<typeof createState> {
	return createState({
		version: "1.0.0",
		info: FOOTER_INFO,
		history: history ? [{ prompt: "old", response: [] }] : [],
		stdin: new FakeInput(),
		stdout: new FakeOutput(),
	});
}

describe("启动标志扫光", () => {
	it("按墙钟推进，扫完自动停下", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const state = newState();
		let renders = 0;

		startBannerShine(state, () => {
			renders += 1;
		});

		assert.equal(state.bannerShine, 0);
		assert.ok(state.bannerTimer !== undefined);

		t.mock.timers.tick(BANNER_FRAME_MS);
		assert.ok((state.bannerShine ?? 0) > 0);
		assert.equal(renders, 1);

		t.mock.timers.tick(BANNER_SWEEP_MS);
		assert.equal(state.bannerTimer, undefined);
		assert.equal(state.bannerShine, undefined);
		const settled = renders;
		assert.ok(settled > 1);

		t.mock.timers.tick(BANNER_SWEEP_MS);
		assert.equal(renders, settled);
	});

	it("重复调用不会叠加定时器", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const state = newState();
		let renders = 0;

		startBannerShine(state, () => {
			renders += 1;
		});
		startBannerShine(state, () => {
			renders += 1;
		});
		t.mock.timers.tick(BANNER_FRAME_MS);

		assert.equal(renders, 1);
		stopBannerShine(state);
	});

	it("有历史对话时不启动", () => {
		const state = newState(true);
		let renders = 0;

		startBannerShine(state, () => {
			renders += 1;
		});

		assert.equal(state.bannerTimer, undefined);
		assert.equal(state.bannerShine, undefined);
		assert.equal(renders, 0);
	});

	it("对话流接管后提前停止", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const state = newState();
		let renders = 0;

		startBannerShine(state, () => {
			renders += 1;
		});
		state.hasInput = true;
		t.mock.timers.tick(BANNER_FRAME_MS);

		assert.equal(state.bannerTimer, undefined);
		assert.equal(state.bannerShine, undefined);
		assert.equal(renders, 0);
	});

	it("整屏页接管后提前停止", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const state = newState();
		let renders = 0;

		startBannerShine(state, () => {
			renders += 1;
		});
		state.openPage = "help";
		t.mock.timers.tick(BANNER_FRAME_MS);

		assert.equal(state.bannerTimer, undefined);
		assert.equal(state.bannerShine, undefined);
		assert.equal(renders, 0);
	});

	it("退出后不再重绘", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const state = newState();
		let renders = 0;

		startBannerShine(state, () => {
			renders += 1;
		});
		state.finished = true;
		t.mock.timers.tick(BANNER_FRAME_MS);

		assert.equal(state.bannerTimer, undefined);
		assert.equal(renders, 0);
	});

	it("收尾时清理定时器并回到静止", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const state = newState();
		let renders = 0;

		startBannerShine(state, () => {
			renders += 1;
		});
		stopBannerShine(state);

		assert.equal(state.bannerTimer, undefined);
		assert.equal(state.bannerShine, undefined);
		t.mock.timers.tick(BANNER_SWEEP_MS);
		assert.equal(renders, 0);
	});
});
