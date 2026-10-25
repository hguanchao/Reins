import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MODEL_MENU_MAX_VISIBLE,
	modelMenuHeight,
	renderModelMenu,
	type ModelMenuItem,
} from "../../../src/tui/panel/model-menu.ts";
import { PANEL_BG, SELECTED_TEXT_COLOR, TEXT_COLOR } from "../../../src/tui/panel/menu-panel.ts";

const BORDER = "─";

const ITEMS: readonly ModelMenuItem[] = [
	{
		provider: "fengshao",
		model: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		current: true,
	},
	{ provider: "openai", model: "gpt-5.2", name: "GPT-5.2", current: false },
	{ provider: "openai", model: "gpt-5.2-mini", name: "GPT-5.2 Mini", current: false },
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("模型选择面板", () => {
	it("高度由可见行数与上下边框组成", () => {
		assert.equal(modelMenuHeight(0), 2);
		assert.equal(modelMenuHeight(3), 5);
		assert.equal(modelMenuHeight(20), MODEL_MENU_MAX_VISIBLE + 2);
	});

	it("上边框右侧显示总数并保留 4 个尾部横线", () => {
		const lines = renderModelMenu(72, { items: ITEMS, cursor: 0, scrollTop: 0 });

		assert.equal(lines.length, 5);
		assert.equal(plain(lines[0] ?? "").length, 72);
		assert.ok(plain(lines[0] ?? "").endsWith(" 3 ────"));
	});

	it("各列对齐：选择符、模型标识、展示名、current", () => {
		const raw = renderModelMenu(72, { items: ITEMS, cursor: 0, scrollTop: 0 });
		const lines = raw.map(plain);

		assert.ok(lines[1]?.startsWith(" › fengshao/deepseek-v4.1-flash"));
		assert.ok(lines[2]?.startsWith("   openai/gpt-5.2"));
		assert.equal(lines[1]?.indexOf("DeepSeek V4.1 Flash"), 35);
		assert.equal(lines[2]?.indexOf("GPT-5.2"), 35);
		assert.equal(lines[1]?.indexOf("current"), 65);
		assert.equal(lines[2]?.includes("current"), false);
		assert.equal(lines[4], BORDER.repeat(72));
		assert.ok((raw[1] ?? "").startsWith(PANEL_BG + SELECTED_TEXT_COLOR));
		assert.ok((raw[2] ?? "").startsWith(PANEL_BG + TEXT_COLOR));
	});

	it("移动光标只改变选中行", () => {
		const lines = renderModelMenu(72, { items: ITEMS, cursor: 1, scrollTop: 0 });

		assert.ok((lines[1] ?? "").startsWith(PANEL_BG + TEXT_COLOR));
		assert.ok((lines[2] ?? "").startsWith(PANEL_BG + SELECTED_TEXT_COLOR));
		assert.ok(plain(lines[2] ?? "").startsWith(" › openai/gpt-5.2"));
		assert.equal(plain(lines[1] ?? "").includes("›"), false);
	});

	it("窄终端先隐藏展示名，再截断模型标识", () => {
		const lines = renderModelMenu(38, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);

		assert.equal(lines[1]?.length, 38);
		assert.equal(lines[1]?.includes("DeepSeek V4.1 Flash"), false);
		assert.ok(lines[1]?.includes("…"));
		assert.ok(lines[1]?.includes("current"));
	});

	it("超过 8 个模型时按 scrollTop 截取可见窗口", () => {
		const items = Array.from({ length: 10 }, (_, index) => ({
			provider: "p",
			model: `m${index}`,
			name: `M${index}`,
			current: index === 9,
		}));
		const state = { items, cursor: 9, scrollTop: 2 };
		const lines = renderModelMenu(60, state);
		const rows = lines.map(plain);

		assert.equal(lines.length, MODEL_MENU_MAX_VISIBLE + 2);
		assert.ok(rows[1]?.includes("p/m2"));
		assert.ok(rows[8]?.startsWith(" › p/m9"));
	});
});
