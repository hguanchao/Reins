import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveScrollMaskState } from "#web/components/ui/scroll-mask.ts";

/**
 * 渐隐视口的四态机:按可滚动量与 scrollTop 推导遮罩方向。
 * 测试环境没有 DOM,这里用普通对象伪造出函数用到的三个只读属性。
 */
interface FakeViewport {
	readonly scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

function fakeViewport(scrollTop: number, scrollHeight: number, clientHeight: number): FakeViewport {
	return { scrollTop, scrollHeight, clientHeight };
}

/** 函数只读三个数值属性,测试环境没有 DOM,统一从这里转成它期望的形状 */
const asViewport = (view: FakeViewport): Parameters<typeof resolveScrollMaskState>[0] =>
	view as unknown as Parameters<typeof resolveScrollMaskState>[0];

describe("渐隐视口遮罩状态", () => {
	it("内容不超出视口时无遮罩", () => {
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(0, 500, 500))), "none");
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(0, 499, 500))), "none");
	});

	it("滚动量只有 1px 时按不可滚动处理", () => {
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(0, 501, 500))), "none");
	});

	it("停在顶部时只隐下缘", () => {
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(0, 1200, 500))), "bottom");
	});

	it("停在底部时只隐上缘", () => {
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(700, 1200, 500))), "top");
	});

	it("停在中间时上下都隐", () => {
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(300, 1200, 500))), "both");
	});

	it("边界附近留一像素容差再判定该侧已隐藏", () => {
		// scrollTop 越过 1 视为顶部已滚走;差 1px 到底视为底部已贴住,中间区段才算 both
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(2, 1200, 500))), "both");
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(698, 1200, 500))), "both");
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(1, 1200, 500))), "bottom");
		assert.equal(resolveScrollMaskState(asViewport(fakeViewport(699, 1200, 500))), "top");
	});
});
