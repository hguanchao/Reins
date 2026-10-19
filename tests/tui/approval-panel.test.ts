import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	APPROVAL_PANEL_HEIGHT,
	renderApprovalPanel,
} from "../../src/tui/approval-panel.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("审批面板", () => {
	it("显示问题、参数缩略与默认拒绝提示", () => {
		const lines = renderApprovalPanel(40, {
			question: "Allow bash to run?",
			detail: '{\n  "command": "npm test"\n}',
		});
		const rows = lines.map(plain);

		assert.equal(lines.length, APPROVAL_PANEL_HEIGHT);
		assert.ok(rows[1]?.includes("Allow bash to run?"));
		assert.ok(rows[1]?.includes("[y/N]"));
		assert.ok(rows[2]?.includes('{ "command": "npm test" }'));
		assert.equal(rows[0], "─".repeat(40));
		assert.equal(rows[3], "─".repeat(40));
	});
});
