import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrollTopForRow, scrollbarColumn, scrollbarThumb, transcriptMetrics } from "../../../src/tui/transcript.ts";


function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("滚动条列", () => {
	function marks(height: number, total: number, top: number): string {
		return scrollbarColumn(height, total, top).map(plain).join("");
	}

	it("滑块只有一段，两端是轨道", () => {
		const column = marks(10, 100, 45);
		const first = column.indexOf("█");
		const last = column.lastIndexOf("█");

		assert.ok(first > 0);
		assert.ok(last < column.length - 1);
		// 首尾之间不能有轨道，否则滑块就是断的
		assert.equal(column.slice(first, last + 1).includes(" "), false);
	});

	it("滚到顶部时滑块贴顶，到底部时贴底", () => {
		assert.ok(marks(10, 100, 0).startsWith("█"));
		assert.ok(marks(10, 100, 90).endsWith("█"));
	});

	it("滚过内容末尾时滑块仍停在底部", () => {
		assert.ok(marks(10, 20, 999).endsWith("█"));
	});

	it("内容没超出视口时整列为空", () => {
		assert.equal(marks(10, 10, 0).trim(), "");
	});

	it("滑块位置随滚动量变化，不会卡在一处", () => {
		// 内容 28 行 + 13 行留白，视口 26 行：真实可滚 15 行
		const tops = [0, 5, 10, 15].map((top) => marks(26, 41, top).indexOf("█"));

		for (let index = 1; index < tops.length; index += 1) {
			assert.ok(
				(tops[index] ?? 0) > (tops[index - 1] ?? 0),
				`第 ${index} 次滚动滑块没有下移：${tops.join(", ")}`,
			);
		}
	});

	it("拖到哪，滑块就落在哪", () => {
		const height = 26;
		const scrollLines = 41;
		const maxScroll = scrollLines - height;
		const thumb = scrollbarThumb(height, scrollLines);

		// 滑块中心能覆盖的那几行：拖过去之后中心应当落在光标上
		for (const row of [10, 14, 18]) {
			const top = scrollTopForRow(row, height, maxScroll);
			const thumbTop = Math.round((top / maxScroll) * thumb.maxTop);
			assert.equal(
				thumbTop + Math.floor(thumb.height / 2),
				row - 1,
				`拖到第 ${row} 行时滑块中心不在光标处`,
			);
		}

		// 两端收敛：拖到顶就是 0，拖到底就是最大滚动量
		assert.equal(scrollTopForRow(1, height, maxScroll), 0);
		assert.equal(scrollTopForRow(height, height, maxScroll), maxScroll);
	});

	it("内容不足一屏时不留可滚的空白", () => {
		const metrics = transcriptMetrics(40, 12, [
			{ prompt: "one", response: ["x"] },
			{ prompt: "two", response: [] },
		]);

		assert.equal(metrics.scrollLines, metrics.totalLines);
	});
});
