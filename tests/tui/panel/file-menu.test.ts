import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	fileMenuHeight,
	filterFiles,
	findAtToken,
	formatFileReference,
	renderFileMenu,
} from "../../../src/tui/panel/file-menu.ts";
import { displayWidth } from "../../../src/tui/render/text.ts";

const FILES = [
	"src/tui/layout.ts",
	"src/tui/text.ts",
	"src/tui/theme.ts",
	"tests/tui/layout.test.ts",
	"README.md",
	"shots/screen.png",
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("@ 文件片段", () => {
	it("识别行首与空白后的 @，并给出光标前的过滤词", () => {
		assert.deepEqual(findAtToken("@src", 4), { start: 0, end: 4, query: "src" });
		assert.deepEqual(findAtToken("看一下 @src/tu", 11), {
			start: 4,
			end: 11,
			query: "src/tu",
		});
		// 光标停在片段中间：过滤词只到光标，插入时仍替换整段
		assert.deepEqual(findAtToken("x @src/tui", 8), { start: 2, end: 10, query: "src/t" });
	});

	it("邮箱、词中间的 @ 与没有 @ 的文本都不触发", () => {
		assert.equal(findAtToken("name@example.com", 8), undefined);
		assert.equal(findAtToken("(@file", 5), undefined);
		assert.equal(findAtToken("plain text", 5), undefined);
		assert.equal(findAtToken("@", 0), undefined);
	});
});

describe("@ 文件过滤", () => {
	it("优先文件名前缀，其次路径前缀与包含", () => {
		const result = filterFiles(FILES, "text");
		assert.deepEqual(result, ["src/tui/text.ts"]);

		const layout = filterFiles(["tests/layout.ts", "src/layout.ts", "src/tui/layout.ts"], "layout");
		assert.deepEqual(layout, ["src/layout.ts", "tests/layout.ts", "src/tui/layout.ts"]);
	});

	it("不区分大小写，空查询按原顺序取前几条", () => {
		assert.deepEqual(filterFiles(FILES, "README"), ["README.md"]);
		assert.deepEqual(filterFiles(FILES, ""), FILES);
		assert.equal(filterFiles(FILES, "", 2).length, 2);
	});

	it("没有匹配时返回空列表", () => {
		assert.deepEqual(filterFiles(FILES, "nope"), []);
	});

	it("含空格的路径写回时加引号", () => {
		assert.equal(formatFileReference("src/a.ts"), "@src/a.ts");
		assert.equal(formatFileReference("shots/my screen.png"), '@"shots/my screen.png"');
	});
});

describe("@ 补全面板", () => {
	it("高度随可见条目数、空态与提示变化", () => {
		assert.equal(fileMenuHeight(0), 4);
		assert.equal(fileMenuHeight(2), 5);
	});

	it("显示选中项、图片标记与数量", () => {
		const lines = renderFileMenu(80, {
			items: FILES,
			token: { start: 0, end: 1, query: "" },
			cursor: 0,
			scrollTop: 0,
		}).map(plain);

		assert.ok(lines[0]?.endsWith(" 6 ────"));
		assert.ok(lines[1]?.includes("› src/tui/layout.ts"));
		assert.ok(lines.join("\n").includes("[image]"));
		for (const line of lines) assert.ok(displayWidth(line) <= 80);
	});

	it("长路径保留文件名，目录从左侧截断", () => {
		const long = ["a/very/deep/directory/that/keeps/going/Component.tsx"];
		const rows = renderFileMenu(40, {
			items: long,
			token: { start: 0, end: 1, query: "" },
			cursor: 0,
			scrollTop: 0,
		}).map(plain);

		const text = rows.join("\n");
		assert.ok(text.includes("Component.tsx"));
		assert.ok(text.includes("…"));
	});

	it("窄终端不把行撑出边界", () => {
		for (let width = 4; width <= 120; width += 1) {
			const lines = renderFileMenu(width, {
				items: FILES,
				token: { start: 0, end: 1, query: "" },
				cursor: 0,
				scrollTop: 0,
			}).map(plain);
			for (const line of lines) {
				assert.ok(displayWidth(line) <= width, `${width}: "${line}"`);
			}
		}
	});
});
