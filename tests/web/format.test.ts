import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTokens, relativeTime, workspaceName } from "#web/lib/format.ts";

describe("相对时间", () => {
	const now = Date.now();

	it("一分钟内显示现在", () => {
		assert.equal(relativeTime(new Date(now - 30_000).toISOString()), "现在");
	});

	it("分钟、小时、天使用紧凑单位", () => {
		assert.equal(relativeTime(new Date(now - 5 * 60_000).toISOString()), "5分钟");
		assert.equal(relativeTime(new Date(now - 3 * 3_600_000).toISOString()), "3小时");
		assert.equal(relativeTime(new Date(now - 2 * 86_400_000).toISOString()), "2天");
	});

	it("无效时间返回空串", () => {
		assert.equal(relativeTime("not-a-date"), "");
	});
});

describe("工作区与 Token 文案", () => {
	it("工作区名取最后一级目录", () => {
		assert.equal(workspaceName("E:\\Projects\\Reins"), "Reins");
		assert.equal(workspaceName("/home/chao/reins"), "reins");
	});

	it("Token 数量按千、百万收敛", () => {
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(12_345), "12k");
		assert.equal(formatTokens(1_500_000), "1.5M");
	});
});
