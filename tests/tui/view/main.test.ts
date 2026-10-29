import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { renderMain } from "../../../src/tui/view/main.ts";

const ART_TOP = "████  █████  █████  █   █  █████";

function visible(line: string): string {
	return stripVTControlCharacters(line);
}

describe("主区域启动画面", () => {
	it("标志与版本号整体在给定区域内垂直居中", () => {
		const lines = renderMain(40, 9, "1.2.3");

		assert.equal(lines.length, 9);
		assert.equal(lines[0], "");
		assert.equal(visible(lines[1] ?? "").trimEnd(), `${" ".repeat(4)}${ART_TOP}`);
		assert.equal(lines[6], "");
		assert.equal(visible(lines[7] ?? "").trimEnd(), `${" ".repeat(17)}v1.2.3`);
		assert.equal(lines[8], "");
	});

	it("主区域放不下整块时先去掉空行，保住版本号", () => {
		const lines = renderMain(40, 6, "1.2.3");

		assert.equal(lines.length, 6);
		assert.equal(visible(lines[5] ?? "").trimEnd(), `${" ".repeat(17)}v1.2.3`);
	});

	it("高度不足时先保住标志，按终端宽度截断", () => {
		const lines = renderMain(20, 1, "1.0.0");

		assert.equal(lines.length, 1);
		assert.equal(visible(lines[0] ?? "").trimEnd(), ART_TOP.slice(0, 20).trimEnd());
	});

	it("宽度不足时不产生负缩进，标志按宽度截断", () => {
		const lines = renderMain(2, 2, "1.0.0");

		assert.equal(visible(lines[0] ?? "").trimEnd(), "██");
		assert.equal(visible(lines[1] ?? "").trimEnd(), "█");
	});
});
