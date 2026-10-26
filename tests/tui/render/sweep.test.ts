import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { swept } from "../../../src/tui/render/sweep.ts";

describe("扫光", () => {
	const base = { r: 47, g: 125, b: 109 };
	const highlight = { r: 78, g: 201, b: 176 };

	it("光带中心到达高亮色,两侧按距离衰减回基色", () => {
		const text = "abcdefghijklmn";
		const output = swept(text, 0.5, base, highlight);
		const colors = [...output.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map(
			(match) => `${match[1]};${match[2]};${match[3]}`,
		);

		assert.equal(colors.length, text.length);
		// 相位 0.5 时光带中心在正中;两端离中心超过半径,仍是基色
		assert.equal(colors[0], "47;125;109");
		assert.equal(colors.at(-1), "47;125;109");
		// 中间至少有一个字符亮于基色
		assert.ok(colors.some((color, index) => index > 0 && index < colors.length - 1 && color !== "47;125;109"));
	});

	it("整段以重置码收尾,后续颜色不会被扫光带走", () => {
		assert.ok(swept("abc", 0, base, highlight).endsWith("\x1b[0m"));
	});

	it("空文本也能得到干净输出", () => {
		assert.equal(swept("", 0.5, base, highlight), "\x1b[0m");
	});

	it("emoji 的代理对不会被着色序列拆开", () => {
		const output = swept("x🚀y", 0.5, base, highlight);
		// 每个码位只对应一次着色前缀；按码元遍历时 🚀 会被劈成两个孤立代理项
		const prefixes = [...output.matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)];
		assert.equal(prefixes.length, 3);
		assert.ok(output.includes("🚀"));
	});
});
