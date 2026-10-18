import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { runTui, wheelStepForInterval } from "../../src/tui/layout.ts";

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
const FOCUS = "\x1b[38;2;225;225;225m";
const BLUR = "\x1b[38;2;36;36;36m";
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

	it("回车后提示在顶部，状态行开始等待", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));

			const lines = frameLines(output);
			assert.equal(lines.length, 12);
			const prompt = plain(lines[1] ?? "");
			assert.ok(prompt.startsWith("› hello"));
			assert.equal(prompt.length, 60);
			assert.ok((lines[0] ?? "").includes("\x1b[48;2;36;36;36m"));
			assert.ok((lines[1] ?? "").includes("\x1b[48;2;36;36;36m"));
			assert.ok((lines[2] ?? "").includes("\x1b[48;2;36;36;36m"));
			assert.ok((lines[1] ?? "").includes("\x1b[38;2;225;225;225m"));
			assert.equal((lines[3] ?? "").includes("\x1b[48;2;36;36;36m"), false);
			const status = plain(lines[8] ?? "");
			assert.ok(status.startsWith(" ⠋ Waiting for response...  0.0s"));
			assert.ok(status.endsWith("0.0s  ⇣0"));
			assert.equal(status.length, 58);
			assert.ok((lines[8] ?? "").includes("\x1b[38;2;"));
			assert.equal(plain(lines[10] ?? ""), " › ");
			assert.ok(cursorAt(output, 11, 4));
		} finally {
			exitTui(input);
		}
	});

	it("运行时状态按 Waiting、Thinking、Writing 推进", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));

			t.mock.timers.tick(300);
			let status = plain(frameLines(output)[8] ?? "");
			assert.ok(status.startsWith(" ⠸ Waiting for response...  0.3s"));
			assert.ok(status.endsWith("0.3s  ⇣0"));

			t.mock.timers.tick(400);
			status = plain(frameLines(output)[8] ?? "");
			assert.ok(status.startsWith(" ⠧ Thinking...  0.2s"));
			assert.ok(status.endsWith("0.7s  ⇣0"));

			t.mock.timers.tick(500);
			status = plain(frameLines(output)[8] ?? "");
			assert.ok(status.startsWith(" ⠹ Writing response...  0.2s"));
			assert.ok(status.includes("1.2s  ⇣"));
		} finally {
			exitTui(input);
		}
	});

	it("模拟回复在提示下方增长并保持提示吸顶", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(2500);

			const lines = frameLines(output);
			const main = lines.slice(0, 8).map(plain);
			assert.ok(main[1]?.startsWith("› hello"));
			assert.equal(main[0]?.includes("›"), false);
			assert.equal(main[2]?.includes("›"), false);
			assert.equal(main[3]?.includes("›"), false);
			assert.ok(main.slice(4).join("\n").includes("模拟回复"));

			const status = plain(lines[8] ?? "");
			assert.ok(status.includes("Writing response..."));
			assert.ok(status.includes("2.5s"));
			assert.ok(status.includes("⇣"));
			assert.equal(plain(lines[10] ?? ""), " › ");
		} finally {
			exitTui(input);
		}
	});

	it("滚轮和拖动可以滚动对话流", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(2500);

			const bottom = frameLines(output).slice(0, 8).map(plain);
			assert.ok(bottom.slice(2).join("\n").includes("模拟回复第 15 行"));

			// 拖到顶部，看到最早的回复
			input.emit("data", Buffer.from("\x1b[<0;40;1M"));
			const top = frameLines(output).slice(0, 8).map(plain);
			assert.ok(top[1]?.startsWith("› hello"));
			assert.ok(top.slice(2).join("\n").includes("模拟回复第 1 行"));

			// 拖回底部
			input.emit("data", Buffer.from("\x1b[<32;40;8M"));
			const back = frameLines(output).slice(0, 8).map(plain);
			assert.ok(back.slice(2).join("\n").includes("模拟回复第 15 行"));

			// 松开后滚轮向上，再向下回到跟随
			input.emit("data", Buffer.from("\x1b[<0;40;8m"));
			input.emit("data", Buffer.from("\x1b[<64;20;4M"));
			const scrolled = frameLines(output).slice(0, 8).map(plain);
			assert.ok(scrolled[1]?.startsWith("› hello"));
			assert.notEqual(scrolled.join("\n"), back.join("\n"));

			input.emit("data", Buffer.from("\x1b[<65;20;4M"));
			const followed = frameLines(output).slice(0, 8).map(plain);
			assert.ok(followed.slice(2).join("\n").includes("模拟回复第 15 行"));
		} finally {
			exitTui(input);
		}
	});

	it("发送第二条后新提示落在顶部，旧内容留在上方", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("one\r"));
			t.mock.timers.tick(2500);
			input.emit("data", Buffer.from("two\r"));

			const latest = frameLines(output).slice(0, 8).map(plain);
			assert.ok(latest[1]?.startsWith("› two"));

			// 拖到顶部可以看到旧提示
			input.emit("data", Buffer.from("\x1b[<0;40;1M"));
			const top = frameLines(output).slice(0, 8).map(plain);
			assert.ok(top[1]?.startsWith("› one"));
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

describe("滚轮加速", () => {
	it("滚轮间隔越短，单格滚动越大", () => {
		assert.equal(wheelStepForInterval(Number.POSITIVE_INFINITY), 2);
		assert.equal(wheelStepForInterval(250), 2);
		assert.equal(wheelStepForInterval(125), 4);
		assert.equal(wheelStepForInterval(50), 10);
		assert.equal(wheelStepForInterval(0), 12);
		assert.equal(wheelStepForInterval(1), 12);
	});
});
