import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayWidth } from "../../../src/tui/render/text.ts";
import { THEME } from "../../../src/tui/render/theme.ts";
import { buildTranscriptView, planHeaderInView, renderTranscript } from "../../../src/tui/transcript.ts";
import type { TranscriptPlan, TranscriptTurn } from "../../../src/tui/transcript.ts";


function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("计划卡", () => {
	const plan: TranscriptPlan = {
		kind: "plan",
		text: "# Add Plan mode\n\n## Steps\n\n1. Add the gate.\n2. Add the review page.",
	};

	it("只显示标题与打开提示，完整正文留在计划对象里", () => {
		const turn: TranscriptTurn = { prompt: "hi", response: [plan] };
		const lines = renderTranscript(60, 12, [turn], 0);
		const card = lines.find((line) => plain(line).includes("◇ Plan")) ?? "";

		assert.ok(plain(card).includes("Add Plan mode"));
		assert.ok(plain(card).includes("double-click to view"));
		assert.equal(plain(card).includes("Add the gate"), false);
		assert.ok(card.includes(THEME.accent));
		assert.ok(card.includes(THEME.textPrimary));
		// 每行仍然精确铺满终端宽度
		assert.equal(displayWidth(plain(card)), 60);
	});

	it("窄屏先丢掉提示，标题截断但标记保留", () => {
		const turn: TranscriptTurn = { prompt: "hi", response: [plan] };
		const lines = renderTranscript(24, 12, [turn], 0);
		const card = lines.find((line) => plain(line).includes("◇ Plan")) ?? "";

		assert.equal(plain(card).includes("double-click"), false);
		assert.ok(plain(card).includes("◇ Plan"));
		assert.ok(plain(card).includes("Add"));
		assert.equal(displayWidth(plain(card)), 24);
	});

	it("极窄终端下计划卡也不越过行宽", () => {
		const turn: TranscriptTurn = { prompt: "hi", response: [plan] };
		for (const width of [3, 5, 8, 10]) {
			const lines = renderTranscript(width, 12, [turn], 0);
			for (const line of lines) {
				assert.equal(displayWidth(plain(line)), width, `宽度 ${width} 下行宽不精确`);
			}
		}
	});

	it("双击头行命中计划，卡下面的内容不命中", () => {
		const turn: TranscriptTurn = { prompt: "hi", response: [plan] };
		const view = buildTranscriptView(60, [turn]);
		const row = renderTranscript(60, 12, [turn], 0)
			.map(plain)
			.findIndex((line) => line.includes("◇ Plan")) + 1;

		assert.equal(planHeaderInView(view, 12, 0, row), plan);
		assert.equal(planHeaderInView(view, 12, 0, row + 1), undefined);
	});
});
