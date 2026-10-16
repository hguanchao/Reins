import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LiveRegion } from "../../../src/tui/screen/region.ts";
import {
	concat,
	plain,
	styled,
	type Line,
} from "../../../src/tui/text/line.ts";
import { displayWidth } from "../../../src/tui/text/width.ts";
import { MemoryTerminal, screenOf } from "../memory-terminal.ts";

function createRegion(size = { rows: 6, cols: 20 }): { terminal: MemoryTerminal; region: LiveRegion } {
	const terminal = new MemoryTerminal(size);
	return { terminal, region: new LiveRegion(terminal, { colors: true }) };
}

describe("LiveRegion", () => {
	it("画出活动区并把光标留给你指定的位置", () => {
		const { terminal, region } = createRegion();
		region.draw({
			lines: [plain("> 输入"), plain("状态行")],
			cursor: { row: 0, col: 2 },
		});

		const screen = screenOf(terminal);
		assert.deepEqual(screen.visible().slice(0, 2), ["> 输入", "状态行"]);
		assert.deepEqual(screen.cursor(), { row: 0, col: 2 });
	});

	it("重画时只擦掉活动区自己的行，不动上面的历史", () => {
		const { terminal, region } = createRegion();
		region.commit([plain("第一行历史")]);
		region.draw({ lines: [plain("活动一"), plain("活动二")] });

		region.draw({ lines: [plain("换过的活动")] });

		const screen = screenOf(terminal);
		assert.deepEqual(screen.visible().slice(0, 2), ["第一行历史", "换过的活动"]);
		// 旧的两行只剩一行新内容，多余的那行已被清空
		assert.equal(screen.visible()[2], "");
	});

	it("活动区变高变矮都不会残留", () => {
		const { terminal, region } = createRegion();
		region.draw({ lines: [plain("一")] });
		region.draw({ lines: [plain("一"), plain("二"), plain("三")] });
		assert.deepEqual(screenOf(terminal).visible().slice(0, 3), ["一", "二", "三"]);

		region.draw({ lines: [plain("收尾")] });
		const screen = screenOf(terminal);
		assert.deepEqual(screen.visible().slice(0, 2), ["收尾", ""]);
	});

	it("提交内容进滚动区后把活动区重画在下面", () => {
		const { terminal, region } = createRegion();
		region.draw({ lines: [plain("输入中")] });
		region.commit([plain("已提交甲"), plain("已提交乙")]);
		region.draw({ lines: [plain("下一个提示")] });

		const screen = screenOf(terminal);
		assert.deepEqual(screen.visible().slice(0, 3), ["已提交甲", "已提交乙", "下一个提示"]);
	});

	it("提交的内容留在滚动区，之后的活动区重画不会碰它", () => {
		const { terminal, region } = createRegion({ rows: 4, cols: 20 });
		for (let index = 0; index < 6; index += 1) {
			region.commit([plain(`第 ${index} 条`)]);
		}
		region.draw({ lines: [plain("输入框")] });

		const screen = screenOf(terminal);
		assert.deepEqual(screen.visible(), ["第 3 条", "第 4 条", "第 5 条", "输入框"]);
		assert.deepEqual(screen.scrolled(), ["第 0 条", "第 1 条", "第 2 条"]);
	});

	it("内容没变就不写任何字节", () => {
		const { terminal, region } = createRegion();
		region.draw({ lines: [plain("一样的内容")] });
		const before = terminal.writes.length;

		region.draw({ lines: [plain("一样的内容")] });
		region.draw({ lines: [plain("一样的内容")] });

		assert.equal(terminal.writes.length, before);
	});

	it("一帧只写一次", () => {
		const { terminal, region } = createRegion();
		region.draw({ lines: [plain("甲"), plain("乙"), plain("丙")] });
		assert.equal(terminal.writes.length, 1);
	});

	it("清空活动区后不再留下任何界面内容", () => {
		const { terminal, region } = createRegion();
		region.commit([plain("历史")]);
		region.draw({ lines: [plain("活动一"), plain("活动二")] });

		region.clear();

		const screen = screenOf(terminal);
		assert.deepEqual(screen.visible().slice(0, 2), ["历史", ""]);
	});

	it("宽字符按显示列计算光标位置", () => {
		const { terminal, region } = createRegion();
		const line: Line = concat(plain("中文"), styled("ab", { bold: true }));
		assert.equal(displayWidth("中文"), 4);

		region.draw({ lines: [line], cursor: { row: 0, col: 4 } });
		assert.deepEqual(screenOf(terminal).cursor().col, 4);
	});

	it("不输出颜色时样式只剩文本", () => {
		const terminal = new MemoryTerminal({ rows: 4, cols: 20 });
		const region = new LiveRegion(terminal, { colors: false });
		region.draw({ lines: [styled("红色", { color: "red", bold: true })] });

		assert.equal(terminal.writes.join(""), "\r\x1b[2K红色");
	});

	it("没有内容时提交什么都不做", () => {
		const { terminal, region } = createRegion();
		region.commit([]);
		assert.deepEqual(terminal.writes, []);
	});
});
