import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MENU_MAX_VISIBLE, menuListLines } from "#src/tui/panel/menu-panel.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const ITEMS = Array.from({ length: 12 }, (_, index) => `item-${index}`);

describe("面板列表骨架", () => {
	it("上下边框各一条，中间最多一屏条目", () => {
		const lines = menuListLines(
			20,
			ITEMS,
			{ cursor: 0, scrollTop: 0 },
			() => undefined,
			(_width, item, selected) => `${selected ? ">" : " "}${item}`,
		);
		assert.equal(lines.length, MENU_MAX_VISIBLE + 2);
		assert.ok(plain(lines[0] ?? "").startsWith("───"));
		assert.ok(plain(lines[1] ?? "").includes("item-0"));
		assert.ok(plain(lines.at(-1) ?? "").startsWith("───"));
	});

	it("光标超出可见窗口时滚动窗口跟随", () => {
		const lines = menuListLines(
			20,
			ITEMS,
			{ cursor: MENU_MAX_VISIBLE, scrollTop: 0 },
			() => undefined,
			(_width, item, selected) => `${selected ? ">" : " "}${item}`,
		);
		assert.ok(plain(lines.at(-2) ?? "").includes(`>item-${MENU_MAX_VISIBLE}`));
	});

	it("空列表只画上下边框与数量 0", () => {
		const lines = menuListLines(
			20,
			[],
			{ cursor: 0, scrollTop: 0 },
			() => undefined,
			() => "row",
		);
		assert.equal(lines.length, 2);
		assert.ok(plain(lines[0] ?? "").includes(" 0 "));
	});
});
