import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	commandMenuHeight,
	renderCommandMenu,
	type CommandMenuItem,
} from "../../../src/tui/panel/command-menu.ts";
import {
	DISABLED_COLOR,
	MENU_MAX_VISIBLE,
	PANEL_BG,
	SELECTED_TEXT_COLOR,
} from "../../../src/tui/panel/menu-panel.ts";

const ITEMS: readonly CommandMenuItem[] = [
	{ name: "model", description: "Switch the current model", enabled: true },
	{ name: "reload", description: "Reload external plugins", enabled: false },
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("命令补全面板", () => {
	it("高度由可见行数、空态与边框组成", () => {
		assert.equal(commandMenuHeight(0), 3);
		assert.equal(commandMenuHeight(2), 4);
		assert.equal(commandMenuHeight(20), MENU_MAX_VISIBLE + 2);
	});

	it("上边框显示匹配数量，命令名与说明按列对齐", () => {
		const lines = renderCommandMenu(72, { items: ITEMS, cursor: 0, scrollTop: 0 });
		const rows = lines.map(plain);

		assert.equal(lines.length, 4);
		assert.ok(rows[0]?.endsWith(" 2 ────"));
		assert.ok(rows[1]?.startsWith(" › /model"));
		assert.ok(rows[2]?.startsWith("   /reload"));
		// 和输入框的 " › /" 前缀对齐：选择符在第 1 列，斜杠在第 3 列
		assert.equal(rows[1]?.indexOf("›"), 1);
		assert.equal(rows[1]?.indexOf("/"), 3);
		assert.equal(rows[2]?.indexOf("/"), 3);
		assert.equal(rows[1]?.indexOf("Switch the current model"), 14);
		assert.equal(rows[2]?.indexOf("Reload external plugins"), 14);
		assert.equal(rows[3], "─".repeat(72));
	});

	it("没有匹配时保留面板并显示空态", () => {
		const rows = renderCommandMenu(72, { items: [], cursor: 0, scrollTop: 0 }).map(plain);
		assert.equal(rows.length, 3);
		assert.ok(rows[0]?.endsWith(" 0 ────"));
		assert.ok(rows[1]?.includes("No matching commands."));
	});

	it("选中行只高亮字体，禁用命令使用弱化颜色", () => {
		const lines = renderCommandMenu(72, { items: ITEMS, cursor: 0, scrollTop: 0 });

		assert.ok((lines[1] ?? "").startsWith(PANEL_BG + SELECTED_TEXT_COLOR));
		assert.ok((lines[2] ?? "").startsWith(PANEL_BG + DISABLED_COLOR));
	});

	it("窄终端隐藏说明列", () => {
		const rows = renderCommandMenu(10, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);

		assert.equal(rows[1]?.length, 10);
		assert.equal(rows[1]?.includes("Switch"), false);
	});
});
