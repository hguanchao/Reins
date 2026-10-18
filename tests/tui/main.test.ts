import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMain, renderMessages } from "../../src/tui/main.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("主区域", () => {
	it("品牌名在上、版本号在下，整体居中", () => {
		const pad = " ".repeat(7);
		const lines = renderMain(20, 5, "1.2.3");

		assert.deepEqual(lines, ["", `${pad}Reins`, `${pad}v1.2.3`, "", ""]);
	});

	it("高度不足时先保住品牌名", () => {
		assert.deepEqual(renderMain(10, 1, "1.0.0"), ["  Reins"]);
	});

	it("宽度不足时不产生负缩进", () => {
		assert.deepEqual(renderMain(2, 2, "1.0.0"), ["Reins", "v1.0.0"]);
	});
});

describe("用户消息块", () => {
	it("单条消息固定三行，正文在第二行左对齐", () => {
		const lines = renderMessages(20, 9, ["hello"]);

		assert.equal(lines.length, 9);
		assert.deepEqual(lines.slice(3), ["", "", "", "", "", ""]);

		const block = lines.slice(0, 3);
		assert.equal(block.length, 3);
		assert.ok(block.every((line) => line.startsWith("\x1b[48;2;46;46;46m") && line.endsWith("\x1b[0m")));
		assert.equal(plain(block[0]), " ".repeat(20));
		assert.equal(plain(block[1]), ` › hello${" ".repeat(12)}`);
		assert.equal(plain(block[2]), " ".repeat(20));
	});

	it("正文超出宽度时用省略号收尾", () => {
		const lines = renderMessages(10, 9, ["abcdefghijklmnopqrstuvwxyz"]);

		assert.deepEqual(lines.slice(0, 3).map(plain), [" ".repeat(10), " › abcdef…", " ".repeat(10)]);
	});

	it("只有一条消息时不显示滚动条", () => {
		const lines = renderMessages(20, 9, ["hello"]).map(plain);

		assert.equal(lines.some((line) => line.endsWith("█") || line.endsWith("│")), false);
	});

	it("有旧消息时默认只展开最新一条", () => {
		const lines = renderMessages(20, 9, ["one", "two", "three", "four"]);
		const plainLines = lines.map(plain);
		const text = plainLines.join("\n");

		assert.ok(text.includes("› four"));
		assert.equal(text.includes("› three"), false);
		assert.equal(text.includes("› two"), false);
		assert.equal(text.includes("› one"), false);

		assert.equal(plainLines.every((line) => line.endsWith("█") || line.endsWith("│")), true);
		assert.equal(plainLines.filter((line) => line.endsWith("█")).length, 2);
		assert.equal(plainLines.slice(2).every((line) => line.endsWith("│")), true);
		assert.equal(plainLines[0]?.length, 20);
		assert.equal(plainLines[0]?.at(-2), " ");
		assert.ok(lines[0]?.includes("\x1b[38;2;46;46;46m"));
	});

	it("滚动索引切换到更旧的消息", () => {
		const middle = renderMessages(20, 9, ["one", "two", "three", "four"], 1).map(plain);

		assert.ok(middle.join("\n").includes("› three"));
		assert.equal(middle.join("\n").includes("› four"), false);
		assert.equal(middle[1]?.endsWith("│"), true);
		assert.equal(middle[2]?.endsWith("█"), true);

		const oldest = renderMessages(20, 9, ["one", "two", "three", "four"], 3).map(plain);

		assert.ok(oldest.join("\n").includes("› one"));
		assert.equal(oldest[7]?.endsWith("█"), true);
		assert.equal(oldest[8]?.endsWith("█"), true);
	});

	it("没有消息时只返回空白行", () => {
		assert.deepEqual(renderMessages(10, 6, []), ["", "", "", "", "", ""]);
	});

	it("宽字符按显示宽度截断，不留下半个字", () => {
		const lines = renderMessages(8, 3, ["你好世界"]);

		assert.deepEqual(lines.map(plain), [" ".repeat(8), " › 你好…", " ".repeat(8)]);
	});
});
