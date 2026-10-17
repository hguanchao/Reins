import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Viewport } from "../../../src/tui/screen/viewport.ts";

describe("滚动视口", () => {
	it("内容不足一屏时贴尾，start 为 0", () => {
		const viewport = new Viewport();
		assert.deepEqual(viewport.window(5, 10), { start: 0, following: true });
		assert.deepEqual(viewport.window(0, 10), { start: 0, following: true });
	});

	it("内容满屏后跟尾：新内容到达时窗口跟着走", () => {
		const viewport = new Viewport();
		assert.deepEqual(viewport.window(30, 10), { start: 20, following: true });
		assert.deepEqual(viewport.window(31, 10), { start: 21, following: true });
	});

	it("向上逐行滚动时窗口停住，不再被新内容推走", () => {
		const viewport = new Viewport();
		viewport.scrollBy(-5, 30, 10);
		assert.deepEqual(viewport.window(31, 10), { start: 15, following: false });

		// 内容增长，窗口顶端还是绝对行号 15
		assert.deepEqual(viewport.window(40, 10), { start: 15, following: false });
	});

	it("翻到最后一行时恢复跟尾", () => {
		const viewport = new Viewport();
		viewport.scrollBy(-100, 30, 10);
		assert.deepEqual(viewport.window(30, 10), { start: 0, following: false });

		viewport.scrollBy(100, 30, 10);
		assert.deepEqual(viewport.window(30, 10), { start: 20, following: true });
	});

	it("越界滚动夹紧在 [0, last]", () => {
		const viewport = new Viewport();
		viewport.scrollBy(-999, 30, 10);
		assert.equal(viewport.window(30, 10).start, 0);

		viewport.scrollBy(999, 30, 10);
		assert.equal(viewport.window(30, 10).start, 20);
		// 窗口停在 last 不算跟尾，除非正好从跟尾状态出发
		assert.equal(viewport.window(30, 10).following, true);
	});

	it("按页滚动一步半屏", () => {
		const viewport = new Viewport();
		viewport.scrollPages(-1, 32, 10);
		assert.deepEqual(viewport.window(32, 10), { start: 17, following: false });

		viewport.scrollPages(-2, 32, 10);
		assert.deepEqual(viewport.window(32, 10), { start: 7, following: false });
	});

	it("toTop 与 toEnd", () => {
		const viewport = new Viewport();
		viewport.toTop();
		assert.deepEqual(viewport.window(50, 10), { start: 0, following: false });

		// 内容增长不推动
		assert.deepEqual(viewport.window(60, 10), { start: 0, following: false });

		viewport.toEnd();
		assert.deepEqual(viewport.window(60, 10), { start: 50, following: true });
	});

	it("从 last 位置再向下越界时恢复跟尾，没到过 last 就不跟", () => {
		const viewport = new Viewport();
		viewport.toTop();
		// 从 0 向下 5 行：停在 5，不到 last(20)，不恢复跟尾
		viewport.scrollBy(5, 30, 10);
		assert.deepEqual(viewport.window(30, 10), { start: 5, following: false });

		// 越过 last：夹到 20，恢复跟尾
		viewport.scrollBy(100, 30, 10);
		assert.deepEqual(viewport.window(30, 10), { start: 20, following: true });
	});
});
