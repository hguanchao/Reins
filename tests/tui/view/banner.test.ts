import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";

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

function visible(line: string): string {
	return stripVTControlCharacters(line);
}

/** 一帧里出现过的前景色亮度；这里全是灰阶，只看红通道就够区分。 */
function reds(line: string): number[] {
	return [...line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((match) => Number(match[1]));
}

describe("启动标志", () => {
	it("五行块字在上，版本号隔一空行居中", () => {
		const lines = bannerLines(40, "1.0.0", undefined);

		assert.equal(lines.length, 7);
		for (let row = 0; row < ART.length; row += 1) {
			assert.equal(visible(lines[row] ?? "").trimEnd(), `${" ".repeat(4)}${ART[row]}`);
		}
		assert.equal(lines[5], "");
		assert.equal(visible(lines[6] ?? "").trimEnd(), `${" ".repeat(17)}v1.0.0`);
	});

	it("短行补齐到整块宽度，所有行的左缘对齐", () => {
		const lines = bannerLines(40, "1.0.0", undefined);
		const widths = ART.map((_, row) => visible(lines[row] ?? "").length);
		const lefts = ART.map((_, row) => visible(lines[row] ?? "").indexOf("█"));

		assert.ok(widths.every((width) => width === 4 + BLOCK_WIDTH), widths.join(","));
		assert.ok(lefts.every((left) => left === 4), lefts.join(","));
	});

	it("静止时标志与版本号都是 #16191d", () => {
		const lines = bannerLines(40, "1.0.0", undefined);

		for (const line of lines.slice(0, 5).concat(lines[6] ?? "")) {
			assert.deepEqual(new Set(reds(line)), new Set([22]));
		}
	});

	it("扫光与运行时状态共用暗部与亮点，版本号保持静止", () => {
		const lines = bannerLines(40, "1.0.0", 0.5);
		const artReds = lines.slice(0, 5).flatMap(reds);

		assert.ok(Math.max(...artReds) > 47);
		assert.ok(Math.min(...artReds) >= 47);
		assert.deepEqual(new Set(reds(lines[6] ?? "")), new Set([22]));
	});

	it("整块共用一个相位，光带竖直从左往右", () => {
		const lines = bannerLines(40, "1.0.0", 0.5);
		const peaks = lines.slice(0, 5).map((line) => {
			const values = reds(line);
			return values.indexOf(Math.max(...values));
		});

		assert.deepEqual(new Set(peaks), new Set([peaks[0]]));
	});

	it("扫到最右端时只剩暗部", () => {
		const lines = bannerLines(40, "1.0.0", 1);

		for (const line of lines.slice(0, 5)) {
			assert.equal(Math.max(...reds(line)), 47);
		}
	});

	it("终端比整块窄时不缩进也不截断", () => {
		const lines = bannerLines(20, "1.0.0", undefined);

		for (let row = 0; row < ART.length; row += 1) {
			assert.equal(visible(lines[row] ?? "").trimEnd(), ART[row]);
		}
		assert.equal(visible(lines[6] ?? "").trimEnd(), `${" ".repeat(13)}v1.0.0`);
	});
});
