import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LiveRegion, ScreenRegion } from "../../../src/tui/screen/region.ts";
import { plain, styled } from "../../../src/tui/text/line.ts";
import type { TerminalDevice, TerminalSize } from "../../../src/tui/terminal/terminal.ts";

/** 哑设备：记住写过什么，尺寸可改，不触真终端。 */
class MemoryDevice implements TerminalDevice {
	output = "";
	sizeValue: TerminalSize;

	constructor(size: Partial<TerminalSize> = {}) {
		this.sizeValue = { rows: 24, cols: 80, ...size };
	}

	size(): TerminalSize {
		return this.sizeValue;
	}

	write(text: string): void {
		this.output += text;
	}
}

describe("活动区 LiveRegion", () => {
	it("首次绘制写出各行，带样式", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		region.draw({ lines: [plain("hi"), styled("!", { bold: true })] });
		assert.ok(device.output.includes("\r\x1b[2Khi"));
		assert.ok(device.output.includes("\x1b[1m!\x1b[0m"));
	});

	it("内容未变时一个字节都不写", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		const frame = { lines: [plain("same")] };
		region.draw(frame);
		const afterFirst = device.output.length;
		region.draw({ ...frame, lines: [plain("same")] });
		assert.equal(device.output.length, afterFirst);
	});

	it("内容变了才重写，且变化的部分是完整一帧", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		region.draw({ lines: [plain("a")] });
		device.output = "";
		region.draw({ lines: [plain("b")] });
		assert.ok(device.output.includes("\r\x1b[2Kb"));
	});

	it("新帧行数变多时，先按旧帧行数擦干净", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		region.draw({ lines: [plain("a"), plain("b")] });
		device.output = "";
		region.draw({ lines: [plain("a"), plain("b"), plain("c")] });
		// 擦除段在重画帧之前：一路向上再逐行清空
		const rendered = device.output;
		const lastRow = rendered.lastIndexOf("\r\x1b[2Kc");
		const erasePart = rendered.slice(0, lastRow);
		assert.ok(erasePart.includes("\x1b[1A")); // 回到上一行
		assert.ok(erasePart.includes("\r\x1b[2K")); // 清行
	});

	it("commit 把行写进滚动区，随后重画活动区", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		region.commit([plain("done")]);
		assert.ok(device.output.includes("done\r\n"));
	});

	it("commit 空行数组不写任何东西", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		region.commit([]);
		assert.equal(device.output, "");
	});

	it("越过宽度的行被截断而不是交给终端折行", () => {
		const device = new MemoryDevice({ cols: 5 });
		const region = new LiveRegion(device, { colors: true });
		region.draw({ lines: [plain("abcdefgh")] });
		assert.ok(device.output.includes("abcd…"));
		assert.ok(!device.output.includes("efgh"));
	});

	it("clear 把画过的内容擦掉", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		region.draw({ lines: [plain("x"), plain("y")] });
		device.output = "";
		region.clear();
		assert.ok(device.output.length > 0);
		assert.ok(device.output.includes("\x1b[2K"));
	});

	it("光标定位：按行列绝对列定位", () => {
		const device = new MemoryDevice();
		const region = new LiveRegion(device, { colors: true });
		region.draw({ lines: [plain("row0"), plain("row1")], cursor: { row: 0, col: 3 } });
		assert.ok(device.output.includes("\x1b[4G")); // 绝对列 3+1
	});
});

describe("整屏绘制 ScreenRegion", () => {
	it("从左上角开始画，光标定位用行列", () => {
		const device = new MemoryDevice();
		const region = new ScreenRegion(device, { colors: true });
		region.draw({ lines: [plain("a"), plain("b")], cursor: { row: 5, col: 2 } });
		assert.ok(device.output.startsWith("\x1b[H"));
		assert.ok(device.output.includes("\x1b[6;3H"));
		// 行与行之间是回车、清行、内容
		assert.ok(device.output.includes("\r\x1b[2Ka\r\n\r\x1b[2Kb"));
	});

	it("内容未变时不写", () => {
		const device = new MemoryDevice();
		const region = new ScreenRegion(device, { colors: true });
		const frame = { lines: [plain("x")] };
		region.draw(frame);
		const size = device.output.length;
		region.draw({ ...frame });
		assert.equal(device.output.length, size);
	});

	it("上一帧更长时把残余行清掉", () => {
		const device = new MemoryDevice();
		const region = new ScreenRegion(device, { colors: true });
		region.draw({ lines: [plain("a"), plain("b"), plain("c")] });
		device.output = "";
		region.draw({ lines: [plain("a")] });
		assert.ok(device.output.includes("\x1b[J"));
	});

	it("变短不触发残余清理", () => {
		const device = new MemoryDevice();
		const region = new ScreenRegion(device, { colors: true });
		region.draw({ lines: [plain("a")] });
		device.output = "";
		region.draw({ lines: [plain("a"), plain("b")] });
		assert.ok(!device.output.includes("\x1b[J"));
	});

	it("clear 清屏并复位", () => {
		const device = new MemoryDevice();
		const region = new ScreenRegion(device, { colors: true });
		region.clear(); // 没画过：无输出
		assert.equal(device.output, "");

		region.draw({ lines: [plain("x")] });
		device.output = "";
		region.clear();
		assert.equal(device.output, "\x1b[H\x1b[2J");
	});

	it("超宽截断", () => {
		const device = new MemoryDevice({ cols: 4 });
		const region = new ScreenRegion(device, { colors: true });
		region.draw({ lines: [plain("abcdef")] });
		assert.ok(device.output.includes("abc…"));
	});
});
