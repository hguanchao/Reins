import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCost, formatTokens } from "../../../src/plugins/tui-plugin/format.ts";

describe("界面上的数字写法", () => {
	it("token 数不足一千原样写，往上按 k 与 M 折算", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1060), "1.1k");
		assert.equal(formatTokens(48_800), "48.8k");
		assert.equal(formatTokens(2_400_000), "2.4M");
	});

	it("负数与小数的脏输入按零处理，不把界面弄花", () => {
		assert.equal(formatTokens(-5), "0");
		assert.equal(formatTokens(12.6), "13");
	});

	it("金额不足一分钱时多留几位，免得一律显示 $0.00", () => {
		assert.equal(formatCost(0.004), "$0.0040");
		assert.equal(formatCost(0.0123), "$0.01");
		assert.equal(formatCost(1.5), "$1.50");
	});
});
