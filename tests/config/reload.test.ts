import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Config } from "#src/config/file.ts";
import { applyLiveConfig, diffConfig } from "#src/config/reload.ts";

const BASE: Config = {
	provider: "p",
	model: "m",
	reasoningEffort: "off",
	contextWindow: undefined,
	maxTokens: undefined,
	maxRetries: 10,
	streamIdleTimeout: 0,
	httpProxy: undefined,
	shellPath: undefined,
	compactModel: undefined,
	reviewModel: undefined,
	approval: "ask",
	sandbox: "off",
	maxTurns: undefined,
	spillThreshold: 8192,
	compaction: { compactAt: 0.8, keepRecent: 0.2, summaryTimeout: 0 },
	ui: { notify: "auto" },
	mcpServers: [],
	plugins: { disabled: [], trusted: [] },
};

describe("配置热更新的分界线", () => {
	it("没有变化时两边都是空的", () => {
		assert.deepEqual(diffConfig(BASE, { ...BASE }), { live: [], restart: [] });
	});

	it("每轮重新读取的项算「立刻生效」", () => {
		const diff = diffConfig(BASE, {
			...BASE,
			reasoningEffort: "high",
			maxRetries: 3,
			approval: "yolo",
			spillThreshold: 0,
			ui: { notify: "off" },
		});

		assert.deepEqual(diff.live, ["reasoningEffort", "maxRetries", "approval", "spillThreshold", "ui"]);
		assert.deepEqual(diff.restart, []);
	});

	it("启动时被别的对象拿走的项算「要重启」", () => {
		const diff = diffConfig(BASE, { ...BASE, sandbox: "workspace", shellPath: "/bin/sh" });

		assert.deepEqual(diff.live, []);
		// 顺序跟着 Config 的字段声明走，断言只看集合
		assert.deepEqual([...diff.restart].sort(), ["sandbox", "shellPath"]);
	});

	it("混合改动分开报，不混为一谈", () => {
		const diff = diffConfig(BASE, { ...BASE, maxTokens: 4096, shellPath: "/bin/sh" });

		assert.deepEqual(diff.live, ["maxTokens"]);
		assert.deepEqual(diff.restart, ["shellPath"]);
	});

	it("嵌套项按值比较，深层变化也算", () => {
		const diff = diffConfig(BASE, {
			...BASE,
			compaction: { ...BASE.compaction, compactAt: 0.6 },
			plugins: { ...BASE.plugins, disabled: ["x"] },
		});

		assert.deepEqual(diff.live, ["compaction"]);
		assert.deepEqual(diff.restart, ["plugins"]);
	});
});

describe("应用能立刻生效的那部分", () => {
	it("只替换列出的项，其余保持原样", () => {
		const next: Config = {
			...BASE,
			reasoningEffort: "high",
			maxRetries: 3,
			approval: "yolo",
			spillThreshold: 0,
			ui: { notify: "off" },
			sandbox: "workspace",
		};
		const applied = applyLiveConfig(BASE, next, [
			"reasoningEffort",
			"maxRetries",
			"approval",
			"spillThreshold",
			"ui",
		]);

		assert.equal(applied.reasoningEffort, "high");
		assert.equal(applied.maxRetries, 3);
		assert.equal(applied.approval, "yolo");
		assert.equal(applied.spillThreshold, 0);
		assert.equal(applied.ui.notify, "off");
		// 沙箱要重启才生效，这里必须还是旧值
		assert.equal(applied.sandbox, "off");
	});

	it("没有可应用的项时原样返回", () => {
		assert.deepEqual(applyLiveConfig(BASE, { ...BASE, sandbox: "workspace" }, []), BASE);
	});
});
