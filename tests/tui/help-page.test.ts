import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eastAsianWidth } from "get-east-asian-width";

import type { CommandMenuItem } from "../../src/tui/command-menu.ts";
import { helpPageLines, renderHelpPage } from "../../src/tui/help-page.ts";

const COMMANDS: readonly CommandMenuItem[] = [
	{ name: "model", description: "Choose the model for this session", enabled: true },
	{ name: "help", description: "Show the commands and keys", enabled: true },
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function width(text: string): number {
	let total = 0;
	for (const char of text) total += eastAsianWidth(char.codePointAt(0) ?? 0);
	return total;
}

describe("整屏帮助页", () => {
	it("标题、命令与按键分区呈现", () => {
		const rows = helpPageLines(80, COMMANDS).map(plain);
		const text = rows.join("\n");

		assert.equal(rows[0], "Reins — help");
		assert.ok(text.includes("Commands"));
		assert.ok(text.includes("Keys"));
		assert.ok(text.includes("/model"));
		assert.ok(text.includes("Choose the model for this session"));
		assert.ok(text.includes("Enter"));
		assert.ok(text.includes("Send the prompt"));
		assert.ok(text.includes("Esc"));
		assert.ok(text.includes("Ctrl+C twice"));
	});

	it("命令清单由调用方传入，未启用的命令同样列出", () => {
		const disabled: readonly CommandMenuItem[] = [
			{ name: "reload", description: "Reload external plugins", enabled: false },
		];
		const text = helpPageLines(80, disabled).map(plain).join("\n");

		assert.ok(text.includes("/reload"));
		assert.ok(text.includes("Reload external plugins"));
		assert.equal(text.includes("/model"), false);
	});

	it("说明按剩余宽度换行，续行与首行说明对齐，单词不被切开", () => {
		const description = "Choose the model for this session";
		const long: readonly CommandMenuItem[] = [
			{ name: "model", description, enabled: true },
		];
		const rows = helpPageLines(28, long).map(plain);
		const first = rows.findIndex((line) => line.includes("Choose"));

		assert.ok(first > 0);
		// 首行放不下时会另起一行，续行缩进与首行说明起始列一致
		const column = rows[first]?.indexOf("Choose") ?? -1;
		const parts = [rows[first]?.slice(column) ?? ""];
		for (let index = first + 1; index < rows.length; index += 1) {
			const line = rows[index] ?? "";
			if (line.length === 0) break;
			assert.equal(line.search(/\S/), column === 0 ? -1 : column);
			parts.push(line.slice(column));
		}

		// 折行后拼回来与原说明一致，说明每个单词都完整落在某一行里
		assert.equal(parts.join(" "), description);
	});

	it("每一行都不超过给定宽度", () => {
		for (const terminalWidth of [12, 20, 40, 80]) {
			for (const line of helpPageLines(terminalWidth, COMMANDS).map(plain)) {
				assert.ok(width(line) <= terminalWidth, `"${line}" 超出 ${terminalWidth} 列`);
			}
		}
	});

	it("视口取窗口，行数固定为 height", () => {
		const lines = helpPageLines(80, COMMANDS);
		const visible = renderHelpPage(lines, 5, 0);

		assert.equal(visible.length, 5);
		assert.equal(plain(visible[0] ?? ""), "Reins — help");
	});

	it("滚动超出范围时收敛到两端，内容不足时停在顶部", () => {
		const lines = helpPageLines(80, COMMANDS);
		const bottom = renderHelpPage(lines, 5, 9999);
		const top = renderHelpPage(lines, 9999, 5);

		assert.equal(plain(bottom.at(-1) ?? ""), plain(lines.at(-1) ?? ""));
		assert.equal(plain(top[0] ?? ""), "Reins — help");
		assert.equal(top.length, 9999);
		assert.equal(renderHelpPage(lines, 5, -3)[0], lines[0]);
	});

	it("高度为零时不返回任何行", () => {
		assert.deepEqual(renderHelpPage(helpPageLines(80, COMMANDS), 0, 0), []);
	});
});
