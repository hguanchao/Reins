import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMain } from "../../../src/tui/view/main.ts";

describe("主区域启动画面", () => {
	it("品牌名在上、版本号在下，整体居中", () => {
		const pad = " ".repeat(7);
		const lines = renderMain(20, 5, "1.2.3");

		assert.deepEqual(lines, ["", `${pad}Reins`, `${pad}v1.2.3`, "", ""]);
	});

	it("高度不足时先保住品牌名", () => {
		assert.deepEqual(renderMain(10, 1, "1.0.0"), ["  Reins"]);
	});

	it("宽度不足时不产生负缩进", () => {
		assert.deepEqual(renderMain(2, 2, "1.0.0"), ["Reins", "v1.0.0"]);
	});
});
