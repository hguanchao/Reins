import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THINKING_LEVELS } from "../../../src/config/file.ts";
import { effortMenuHeight, renderEffortMenu } from "../../../src/tui/panel/effort-menu.ts";
import { PANEL_BG, SELECTED_TEXT_COLOR, TEXT_COLOR } from "../../../src/tui/panel/menu-panel.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("思考等级面板", () => {
	it("固定显示六个等级，上边框显示数量", () => {
		const lines = renderEffortMenu(40, { items: THINKING_LEVELS, current: "medium", cursor: 2, scrollTop: 0 });
		const rows = lines.map(plain);

		assert.equal(effortMenuHeight(), 8);
		assert.equal(lines.length, 8);
		assert.ok(rows[0]?.endsWith(" 6 ────"));
		assert.deepEqual(
			rows.slice(1, 7).map((line) => line.trim().split(/\s+/).filter((token) => token !== "›")[0]),
			["off", "low", "medium", "high", "xhigh", "max"],
		);
	});

	it("每个等级都有使用场景说明，当前等级和光标分别标记", () => {
		const lines = renderEffortMenu(80, { items: THINKING_LEVELS, current: "medium", cursor: 2, scrollTop: 0 });
		const rows = lines.map(plain);

		assert.equal(rows[1]?.indexOf("No reasoning; fastest responses"), 13);
		assert.ok(rows[2]?.includes("Quick tasks where you review each result"));
		assert.ok(rows[3]?.includes("Everyday work with a clear scope"));
		assert.ok(rows[4]?.includes("Work where correctness and edge cases matter"));
		assert.ok(rows[5]?.includes("Deeper reasoning with higher token cost"));
		assert.ok(rows[6]?.includes("Hard problems that need sustained reasoning"));
		assert.equal(rows[3]?.includes("current"), true);
		assert.equal(rows[1]?.includes("current"), false);
		assert.equal(rows[3]?.indexOf("current"), 73);
		assert.ok((lines[3] ?? "").startsWith(PANEL_BG + SELECTED_TEXT_COLOR));
		assert.ok((lines[1] ?? "").startsWith(PANEL_BG + TEXT_COLOR));
	});

	it("移动光标只改变选中行", () => {
		const lines = renderEffortMenu(40, { items: THINKING_LEVELS, current: "medium", cursor: 3, scrollTop: 0 });

		assert.ok((lines[4] ?? "").startsWith(PANEL_BG + SELECTED_TEXT_COLOR));
		assert.ok((lines[3] ?? "").startsWith(PANEL_BG + TEXT_COLOR));
	});
});
