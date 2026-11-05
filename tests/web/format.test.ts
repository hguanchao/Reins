import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTokens, pluginKindLabel, relativeTime, sandboxLabel, workspaceName } from "#web/lib/format.ts";

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

describe("内部配置值的中文名", () => {
	it("插件形态不直接暴露 dsh / pi / declarative", () => {
		assert.equal(pluginKindLabel("dsh"), "DSH 兼容");
		assert.equal(pluginKindLabel("pi"), "Pi 兼容");
		assert.equal(pluginKindLabel("declarative"), "声明式");
		assert.equal(pluginKindLabel("other"), "other");
	});

	it("沙箱模式不直接暴露 off / workspace / read-only", () => {
		assert.equal(sandboxLabel("off"), "关闭");
		assert.equal(sandboxLabel("workspace"), "仅工作区");
		assert.equal(sandboxLabel("read-only"), "只读");
		assert.equal(sandboxLabel("other"), "other");
	});
});
