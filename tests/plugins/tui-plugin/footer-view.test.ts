import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INPUT_LEFT } from "../../../src/plugins/tui-plugin/input-box.ts";
import { runningRow } from "../../../src/plugins/tui-plugin/footer-view.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("运行状态行", () => {
	it("左边与输入框提示符同列，动作后面跟这一步的耗时，右缘是整轮耗时与上下文规模", () => {
		const line = runningRow({
			activity: "Running Read",
			startedAt: 0,
			phaseStartedAt: 9_500,
			tokens: 12_345,
			width: 60,
			now: 10_000,
		});
		const text = lineText(line);
		assert.equal(text.indexOf("⠸"), INPUT_LEFT, "指示器与输入框的提示符同列");
		assert.ok(text.includes("Running Read 500ms"), `阶段耗时紧跟动作: ${text}`);
		assert.ok(text.endsWith("10.0s ⇣12.3k"), `整轮耗时与令牌数贴住右缘: ${text}`);
		// 占输入框的内区：右侧让出右边框那一格
		assert.equal(lineWidth(line), 60 - 3);
	});

	it("还没有令牌数时只显示整轮耗时", () => {
		const text = lineText(
			runningRow({ activity: "Thinking", startedAt: 0, phaseStartedAt: 0, tokens: 0, width: 60, now: 1_000 }),
		);
		assert.ok(text.endsWith("1.0s"), `右缘只留耗时: ${text}`);
		assert.ok(!text.includes("⇣"), `不写空的令牌数: ${text}`);
	});

	it("动作名放不下时截断，两个计时与令牌数都不动", () => {
		const line = runningRow({
			activity: "Running A_Very_Long_Tool_Name_For_Truncation",
			startedAt: 0,
			phaseStartedAt: 9_500,
			tokens: 12_345,
			width: 40,
			now: 10_000,
		});
		const text = lineText(line);
		assert.ok(text.includes("…"), `动作名截断: ${text}`);
		assert.ok(text.includes("500ms"), `阶段耗时仍在: ${text}`);
		assert.ok(text.endsWith("10.0s ⇣12.3k"), `整轮耗时与令牌数仍在: ${text}`);
		assert.equal(lineWidth(line), 40 - 3);
	});
});
