import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldNotify } from "#web/lib/notify-mode.ts";

describe("桌面通知判定", () => {
	it("关闭与终端响铃都不弹桌面通知", () => {
		assert.equal(shouldNotify("off", false), false);
		assert.equal(shouldNotify("off", true), false);
		assert.equal(shouldNotify("bell", false), false);
		assert.equal(shouldNotify("bell", true), false);
	});

	it("失焦时只在窗口不在前台时通知", () => {
		assert.equal(shouldNotify("auto", false), true);
		assert.equal(shouldNotify("auto", true), false);
	});

	it("桌面通知总是提醒", () => {
		assert.equal(shouldNotify("desktop", false), true);
		assert.equal(shouldNotify("desktop", true), true);
	});
});
