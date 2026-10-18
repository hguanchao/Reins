import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runningRow } from "../../../src/plugins/tui-plugin/footer-view.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("运行状态行", () => {
	it("动作后面跟这一步的耗时，整轮的耗时贴住右缘", () => {
		const line = runningRow({
			activity: "Running Read",
			startedAt: 0,
			phaseStartedAt: 9_500,
			width: 60,
			now: 10_000,
		});
		const text = lineText(line);
		assert.ok(text.includes("Running Read 500ms"), `阶段耗时紧跟动作: ${text}`);
		assert.ok(text.endsWith("10.0s"), `整轮耗时贴右缘: ${text}`);
		// 与会话条目同列缩进，右侧占满内容区
		assert.ok(text.startsWith("     "));
		assert.equal(lineWidth(line), 60 - 2);
	});

	it("动作名放不下时截断，两个耗时都不动", () => {
		const line = runningRow({
			activity: "Running A_Very_Long_Tool_Name_For_Truncation",
			startedAt: 0,
			phaseStartedAt: 9_500,
			width: 40,
			now: 10_000,
		});
		const text = lineText(line);
		assert.ok(text.includes("…"), `动作名截断: ${text}`);
		assert.ok(text.includes("500ms"), `阶段耗时仍在: ${text}`);
		assert.ok(text.endsWith("10.0s"), `整轮耗时仍在: ${text}`);
		assert.equal(lineWidth(line), 40 - 2);
	});
});
