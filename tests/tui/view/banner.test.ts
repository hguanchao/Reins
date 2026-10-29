import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { THEME } from "../../../src/tui/render/theme.ts";
import { bannerLines } from "../../../src/tui/view/banner.ts";

/** 五行块字，与视图里的标志逐字一致；测试直接比对，防止改坏笔画。 */
const ART = [
	"████  █████  █████  █   █  █████",
	"█   █ █        █    ██  █  █",
	"████  ███      █    █ █ █  ████",
	"█  █  █        █    █  ██      █",
	"█   █ █████  █████  █   █  █████",
] as const;
const BLOCK_WIDTH = Math.max(...ART.map((line) => line.length));

const BASE = "107;117;128";

function visible(line: string): string {
	return stripVTControlCharacters(line);
}

/** 一帧里出现过的前景色，按 RGB 三元组返回。 */
function colors(line: string): string[] {
	return [...line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map(
		(match) => `${match[1]};${match[2]};${match[3]}`,
	);
}

describe("启动标志", () => {
	it("五行块字在上，版本号隔一空行居中", () => {
		const lines = bannerLines(40, "1.0.0");

		assert.equal(lines.length, 7);
		for (let row = 0; row < ART.length; row += 1) {
			assert.equal(visible(lines[row] ?? "").trimEnd(), `${" ".repeat(4)}${ART[row]}`);
		}
		assert.equal(lines[5], "");
		assert.equal(visible(lines[6] ?? "").trimEnd(), `${" ".repeat(17)}v1.0.0`);
	});

	it("短行补齐到整块宽度，所有行的左缘对齐", () => {
		const lines = bannerLines(40, "1.0.0");
		const widths = ART.map((_, row) => visible(lines[row] ?? "").length);
		const lefts = ART.map((_, row) => visible(lines[row] ?? "").indexOf("█"));

		assert.ok(widths.every((width) => width === 4 + BLOCK_WIDTH), widths.join(","));
		assert.ok(lefts.every((left) => left === 4), lefts.join(","));
	});

	it("标志与版本号都用弱文字色", () => {
		const lines = bannerLines(40, "1.0.0");

		for (const line of lines.slice(0, 5).concat(lines[6] ?? "")) {
			assert.ok(line.includes(THEME.textSubtle));
			assert.deepEqual(new Set(colors(line)), new Set([BASE]));
		}
	});

	it("终端比整块窄时按宽度截断，版本号仍在屏幕内", () => {
		const lines = bannerLines(20, "1.0.0");

		for (let row = 0; row < ART.length; row += 1) {
			assert.equal(visible(lines[row] ?? "").trimEnd(), ART[row]?.slice(0, 20).trimEnd());
		}
		assert.ok(visible(lines[6] ?? "").includes("v1.0.0"));
	});
});
