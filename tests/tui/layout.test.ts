import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { runTui } from "../../src/tui/layout.ts";

class FakeInput extends EventEmitter {
	readonly isTTY = true;
	rawMode = false;
	resumed = false;

	setRawMode(mode: boolean): this {
		this.rawMode = mode;
		return this;
	}

	resume(): this {
		this.resumed = true;
		return this;
	}

	pause(): this {
		this.resumed = false;
		return this;
	}
}

class FakeOutput extends EventEmitter {
	readonly isTTY = true;
	columns = 40;
	rows = 12;
	readonly chunks: string[] = [];

	write(chunk: string): boolean {
		this.chunks.push(chunk);
		return true;
	}
}

const ENTER = "\x1b[?1049h\x1b[5 q\x1b[?25l\x1b[?1004h\x1b[?1002h\x1b[?1006h";
const CLEAR = "\x1b[H\x1b[2J";
const LEAVE = "\x1b[?1006l\x1b[?1002l\x1b[?1004l\x1b[0 q\x1b[?25h\x1b[?1049l";
const FOCUS = "\x1b[38;2;204;204;204m";
const BLUR = "\x1b[38;2;46;46;46m";
const BORDER = "─";
const CURSOR_SUFFIX = /\x1b\[\d+;\d+H\x1b\[\?25h$/;

function pressCtrlC(input: FakeInput): void {
	input.emit("data", Buffer.from([3]));
}

/** 连按两次；测试失败时也要保证界面收尾。 */
function exitTui(input: FakeInput): void {
	pressCtrlC(input);
	pressCtrlC(input);
}

function rawFrame(output: FakeOutput): string {
	return output.chunks.at(-1) ?? "";
}

/** 去掉末尾的光标定位序列，只看画面本身。 */
function lastFrame(output: FakeOutput): string {
	return rawFrame(output).replace(CURSOR_SUFFIX, "");
}

function frameLines(output: FakeOutput): string[] {
	const frame = lastFrame(output);
	return frame.slice(frame.indexOf(CLEAR) + CLEAR.length).split("\r\n");
}

function cursorAt(output: FakeOutput, row: number, column: number): boolean {
	return rawFrame(output).endsWith(`\x1b[${row};${column}H\x1b[?25h`);
}

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("全屏布局", () => {
	it("进入备用屏，按当前尺寸绘制，连按两次 Ctrl+C 后恢复", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			assert.equal(output.chunks[0], ENTER);
			assert.equal(input.rawMode, true);
			assert.equal(input.resumed, true);
			assert.ok(cursorAt(output, 11, 4));

			const written = output.chunks.length;
			pressCtrlC(input);
			assert.equal(input.rawMode, true);
			assert.equal(output.chunks.length, written);
			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
		assert.equal(input.rawMode, false);
		assert.equal(input.resumed, false);
		assert.equal(output.chunks.at(-1), LEAVE);
	});

	it("第一次 Ctrl+C 不退出，第二次才退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			pressCtrlC(input);

			assert.equal(input.rawMode, true);
			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("超过时间窗口后要重新连按两次", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			pressCtrlC(input);
			t.mock.timers.tick(2000);

			pressCtrlC(input);
			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("主区域在输入框之上居中", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			const lines = frameLines(output);
			assert.equal(lines.length, 12);
			assert.equal(lines[3], `${" ".repeat(17)}Reins`);
			assert.equal(lines[4], `${" ".repeat(17)}v1.2.3`);
			assert.equal(plain(lines[9] ?? ""), BORDER.repeat(40));
			assert.equal(plain(lines[10] ?? ""), " › ");
			assert.equal(plain(lines[11] ?? ""), BORDER.repeat(40));
			assert.ok(lines[9]?.startsWith(FOCUS));
			assert.ok(lines[10]?.startsWith(FOCUS));
			assert.ok(cursorAt(output, 11, 4));
		} finally {
			exitTui(input);
		}
	});

	it("尺寸变化时按新尺寸重画", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			output.columns = 20;
			output.rows = 6;
			output.emit("resize");

			const lines = frameLines(output);
			assert.equal(lines.length, 6);
			assert.equal(lines[0], `${" ".repeat(7)}Reins`);
			assert.equal(lines[1], `${" ".repeat(7)}v1.2.3`);
			assert.equal(plain(lines[3] ?? ""), BORDER.repeat(20));
			assert.equal(plain(lines[4] ?? ""), " › ");
			assert.equal(plain(lines[5] ?? ""), BORDER.repeat(20));
			assert.ok(lines[3]?.startsWith(FOCUS));
			assert.ok(lines[4]?.startsWith(FOCUS));
			assert.ok(cursorAt(output, 5, 4));
		} finally {
			exitTui(input);
		}
	});

	it("终端失去焦点时输入框变暗，重新获得焦点后恢复", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("\x1b[O"));
			let frame = rawFrame(output);
			assert.ok(frame.includes(BLUR));
			assert.equal(frame.includes(FOCUS), false);
			assert.equal(frame.includes("\x1b[?25h"), false);
			assert.equal(plain(frameLines(output)[10] ?? ""), " › ");

			input.emit("data", Buffer.from("\x1b[I"));
			frame = rawFrame(output);
			assert.ok(frame.includes(FOCUS));
			assert.equal(frame.includes(BLUR), false);
			assert.equal(plain(frameLines(output)[10] ?? ""), " › ");
			assert.ok(cursorAt(output, 11, 4));
		} finally {
			exitTui(input);
		}
	});

	it("点击输入框外失去焦点，点击输入框内恢复", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			// 12 行终端里页脚是 10-12 行，点第 5 行算输入框外
			input.emit("data", Buffer.from("\x1b[<0;5;5M"));
			let frame = rawFrame(output);
			assert.ok(frame.includes(BLUR));
			assert.equal(frame.includes(FOCUS), false);
			assert.equal(frame.includes("\x1b[?25h"), false);
			assert.equal(plain(frameLines(output)[10] ?? ""), " › ");

			// 点输入行（第 11 行）重新获得焦点
			input.emit("data", Buffer.from("\x1b[<0;5;11M"));
			frame = rawFrame(output);
			assert.ok(frame.includes(FOCUS));
			assert.equal(frame.includes(BLUR), false);
			assert.equal(plain(frameLines(output)[10] ?? ""), " › ");
			assert.ok(cursorAt(output, 11, 4));
		} finally {
			exitTui(input);
		}
	});

	it("输入框一有输入，品牌名与版本号就隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("a"));

			const typed = frameLines(output);
			assert.equal(typed.join("\n").includes("Reins"), false);
			assert.equal(typed.join("\n").includes("v1.2.3"), false);
			assert.equal(plain(typed[10] ?? ""), " › a");
			assert.ok(cursorAt(output, 11, 5));
		} finally {
			exitTui(input);
		}
	});

	it("回车发送后主区域显示三行用户消息块", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello"));
			input.emit("data", Buffer.from("\r"));

			const lines = frameLines(output);
			assert.equal(lines.length, 12);
			assert.equal(plain(lines[10] ?? ""), " › ");

			const main = lines.slice(0, 9);
			assert.equal(main.filter((line) => line.includes("\x1b[48;2;46;46;46m")).length, 3);
			assert.equal(main[0]?.includes("›"), false);
			assert.ok(main[1]?.includes("› hello"));
			assert.equal(main[2]?.includes("›"), false);

			const content = plain(main[1] ?? "");
			assert.equal(content.length, 40);
			assert.ok(content.startsWith(" › hello"));
			assert.equal(lines.join("\n").includes("Reins"), false);
			assert.ok(cursorAt(output, 11, 4));
		} finally {
			exitTui(input);
		}
	});

	it("连续发送的消息依次堆叠", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("one\r"));
			input.emit("data", Buffer.from("two\r"));

			const main = frameLines(output).slice(0, 9);
			assert.equal(main.filter((line) => line.includes("\x1b[48;2;46;46;46m")).length, 6);
			assert.ok(main[1]?.includes("› one"));
			assert.equal(main[3], "");
			assert.ok(main[5]?.includes("› two"));
		} finally {
			exitTui(input);
		}
	});

	it("消息溢出主区域时右侧显示滚动条", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("one\r"));
			input.emit("data", Buffer.from("two\r"));
			input.emit("data", Buffer.from("three\r"));

			const main = frameLines(output).slice(0, 9).map(plain);
			assert.equal(main.every((line) => line.endsWith("█") || line.endsWith("│")), true);
			assert.equal(main[0]?.endsWith("│"), true);
			assert.equal(main[1]?.endsWith("│"), true);
			assert.equal(main[2]?.endsWith("█"), true);
			assert.equal(main[8]?.endsWith("█"), true);
			assert.equal(main[0]?.length, 40);
			assert.equal(main[0]?.at(-2), " ");
			assert.equal(main.join("\n").includes("› one"), false);
			assert.ok(main.join("\n").includes("› two"));
			assert.ok(main.join("\n").includes("› three"));
		} finally {
			exitTui(input);
		}
	});

	it("滚轮可以滚动消息区", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("one\r"));
			input.emit("data", Buffer.from("two\r"));
			input.emit("data", Buffer.from("three\r"));
			input.emit("data", Buffer.from("four\r"));

			const bottom = frameLines(output).slice(0, 9).map(plain);
			assert.equal(bottom[8]?.endsWith("█"), true);
			assert.equal(bottom.join("\n").includes("› two"), false);

			input.emit("data", Buffer.from("\x1b[<64;20;5M"));
			const scrolled = frameLines(output).slice(0, 9).map(plain);
			assert.equal(scrolled[8]?.endsWith("│"), true);
			assert.ok(scrolled.join("\n").includes("› two"));

			input.emit("data", Buffer.from("\x1b[<65;20;5M"));
			const back = frameLines(output).slice(0, 9).map(plain);
			assert.equal(back[8]?.endsWith("█"), true);
		} finally {
			exitTui(input);
		}
	});

	it("可以拖动滚动条", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("one\r"));
			input.emit("data", Buffer.from("two\r"));
			input.emit("data", Buffer.from("three\r"));
			input.emit("data", Buffer.from("four\r"));

			// 按住滚动条中上部，视图移到中间
			input.emit("data", Buffer.from("\x1b[<0;40;5M"));
			const middle = frameLines(output).slice(0, 9).map(plain);
			assert.equal(middle[8]?.endsWith("│"), true);
			assert.ok(middle.join("\n").includes("› two"));

			// 拖到底部，滑块回到最下端
			input.emit("data", Buffer.from("\x1b[<32;40;9M"));
			const bottom = frameLines(output).slice(0, 9).map(plain);
			assert.equal(bottom[8]?.endsWith("█"), true);

			// 松开后移动鼠标不再滚动
			input.emit("data", Buffer.from("\x1b[<0;40;9m"));
			input.emit("data", Buffer.from("\x1b[<32;40;1M"));
			const afterRelease = frameLines(output).slice(0, 9).map(plain);
			assert.equal(afterRelease[8]?.endsWith("█"), true);
		} finally {
			exitTui(input);
		}
	});

	it("空输入回车不发送", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			const written = output.chunks.length;
			input.emit("data", Buffer.from("\r"));
			assert.equal(output.chunks.length, written);
		} finally {
			exitTui(input);
		}
	});

	it("还没输入就按退格，品牌名与版本号仍然显示", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			const written = output.chunks.length;
			input.emit("data", Buffer.from([0x7f]));

			assert.equal(output.chunks.length, written);
			const lines = frameLines(output);
			assert.ok(lines.join("\n").includes("Reins"));
			assert.ok(lines.join("\n").includes("v1.2.3"));
		} finally {
			exitTui(input);
		}
	});

	it("宽字符输入后光标停在字符之后", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("你好"));

			const lines = frameLines(output);
			assert.equal(plain(lines[10] ?? ""), " › 你好");
			assert.ok(cursorAt(output, 11, 8));
		} finally {
			exitTui(input);
		}
	});

	it("退格清空输入后品牌名与版本号仍然隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from([0x7f]));

			const lines = frameLines(output);
			assert.equal(plain(lines[10] ?? ""), " › ab");
			assert.equal(lines.join("\n").includes("Reins"), false);
			assert.ok(cursorAt(output, 11, 6));

			input.emit("data", Buffer.from([0x7f]));
			input.emit("data", Buffer.from([0x7f]));
			const cleared = frameLines(output);
			assert.equal(cleared.join("\n").includes("Reins"), false);
			assert.equal(cleared.join("\n").includes("v1.2.3"), false);
			assert.equal(plain(cleared[10] ?? ""), " › ");
			assert.ok(cursorAt(output, 11, 4));
		} finally {
			exitTui(input);
		}
	});

	it("方向键等转义序列不会进入输入框", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			const written = output.chunks.length;
			input.emit("data", Buffer.from("\x1b[A"));
			assert.equal(output.chunks.length, written);
		} finally {
			exitTui(input);
		}
	});

	it("普通按键不退出", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("x"));

			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
			assert.equal(input.rawMode, true);
		} finally {
			exitTui(input);
		}
	});
});
