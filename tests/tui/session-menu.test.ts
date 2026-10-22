import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayWidth } from "../../src/tui/menu-panel.ts";
import {
	renderSessionMenu,
	sessionMenuHeight,
	type SessionMenuItem,
} from "../../src/tui/session-menu.ts";

const ITEMS: readonly SessionMenuItem[] = [
	{ id: "0123456789abcdef", title: "Fix the login flow", hint: "2h", current: true },
	{ id: "fedcba9876543210", title: "Write the release notes", hint: "3d", current: false },
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("会话选择面板", () => {
	it("高度由可见行数与边框组成", () => {
		assert.equal(sessionMenuHeight(0), 2);
		assert.equal(sessionMenuHeight(2), 4);
	});

	it("每行显示最近活动、会话标识、标题与 current", () => {
		const rows = renderSessionMenu(80, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);

		assert.ok(rows[0]?.endsWith(" 2 ────"));
		assert.ok(rows[1]?.startsWith(" ›  2h"));
		assert.ok(rows[1]?.includes("0123456789abcdef"));
		assert.ok(rows[1]?.includes("Fix the login flow"));
		assert.ok(rows[1]?.includes("current"));
		assert.ok(rows[2]?.startsWith("    3d"));
		assert.ok(rows[2]?.includes("fedcba9876543210"));
		assert.equal(rows[2]?.includes("current"), false);
	});

	it("窄终端隐藏 current 列，标题仍然可见", () => {
		const rows = renderSessionMenu(40, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);

		assert.equal(rows[1]?.includes("current"), false);
		assert.ok(rows[1]?.includes("Fix the login"));
		for (const line of rows) assert.ok(displayWidth(line) <= 40, `"${line}" 超出 40 列`);
	});

	it("超长标题截断，行宽不超过终端", () => {
		const long: readonly SessionMenuItem[] = [
			{ id: "0123456789abcdef", title: "x".repeat(200), hint: "now", current: false },
		];
		const rows = renderSessionMenu(80, { items: long, cursor: 0, scrollTop: 0 }).map(plain);

		assert.ok(rows[1]?.includes("…"));
		assert.ok(displayWidth(rows[1] ?? "") <= 80);
	});

	it("极窄终端也不把行撑出边界", () => {
		for (const width of [20, 12]) {
			const rows = renderSessionMenu(width, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);
			for (const line of rows) {
				assert.ok(displayWidth(line) <= width, `宽度 ${width}: "${line}"`);
			}
		}
	});
});
