import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planActionLines, planReviewLines, PLAN_ACTION_HEIGHT } from "../../../src/tui/page/plan.ts";
import { displayWidth } from "../../../src/tui/render/text.ts";
import { THEME } from "../../../src/tui/render/theme.ts";
import type { TranscriptPlan } from "../../../src/tui/transcript.ts";

const PLAN: TranscriptPlan = {
	kind: "plan",
	text: "# Add Plan mode\n\n## Summary\nA read-only planning flow.\n\n## Steps\n1. Add the gate.\n",
};

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("计划审批页", () => {
	it("标题之后渲染完整 Markdown，不截断计划正文", () => {
		const lines = planReviewLines(PLAN, 60);
		const text = lines.map(plain).join("\n");

		assert.ok(text.includes("Reins — plan"));
		assert.ok(text.includes("Add Plan mode"));
		assert.ok(text.includes("A read-only planning flow."));
		assert.ok(text.includes("Add the gate."));
		for (const line of lines) {
			assert.equal(displayWidth(plain(line)), 60);
		}
	});

	it("动作条固定在两行：分隔线与按键说明", () => {
		const lines = planActionLines(80);

		assert.equal(PLAN_ACTION_HEIGHT, 2);
		assert.equal(lines.length, 2);
		assert.ok(plain(lines[0] ?? "").match(/^─+$/));
		assert.ok(plain(lines[1] ?? "").includes("a approve & implement"));
		assert.ok(plain(lines[1] ?? "").includes("r request changes"));
		assert.ok(plain(lines[1] ?? "").includes("q leave plan"));
		assert.ok(plain(lines[1] ?? "").includes("Esc close"));
		assert.ok(plain(lines[1] ?? "").includes("↑/↓ scroll"));
		assert.ok(lines[1]?.includes(THEME.accent));
		assert.ok(lines[1]?.includes(THEME.warning));
		assert.equal(displayWidth(plain(lines[1] ?? "")), 80);
	});

	it("中等宽度换成短标签，极窄时截断且不超出终端", () => {
		const medium = planActionLines(50);
		assert.ok(plain(medium[1] ?? "").includes("a approve"));
		assert.ok(plain(medium[1] ?? "").includes("r revise"));
		assert.equal(plain(medium[1] ?? "").includes("request changes"), false);
		assert.equal(displayWidth(plain(medium[1] ?? "")), 50);

		const narrow = planActionLines(28);
		assert.ok(plain(narrow[1] ?? "").includes("a approve"));
		assert.equal(displayWidth(plain(narrow[1] ?? "")), 28);
	});

	it("宽度为零时不产生超宽内容", () => {
		assert.deepEqual(planActionLines(0), ["", ""]);
		for (const line of planReviewLines(PLAN, 0)) {
			assert.equal(displayWidth(plain(line)), 0);
		}
	});
});
