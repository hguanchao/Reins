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

const ENTER = "\x1b[?1049h\x1b[?25l";
const CLEAR = "\x1b[H\x1b[2J";
const LEAVE = "\x1b[?25h\x1b[?1049l";
const HINT = "Press Ctrl+C again to exit";
const CURSOR = "\x1b[7m \x1b[0m";
const BORDER = "─";

function pressCtrlC(input: FakeInput): void {
	input.emit("data", Buffer.from([3]));
}

/** 第一次按键提示，第二次才退出；测试失败时也要保证界面收尾。 */
function exitTui(input: FakeInput): void {
	pressCtrlC(input);
	pressCtrlC(input);
}

function frameLines(output: FakeOutput): string[] {
	const frame = output.chunks.at(-1) ?? "";
	return frame.slice(CLEAR.length).split("\r\n");
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

			pressCtrlC(input);
			assert.equal(input.rawMode, true);
			assert.ok((output.chunks.at(-1) ?? "").includes(HINT));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
		assert.equal(input.rawMode, false);
		assert.equal(input.resumed, false);
		assert.equal(output.chunks.at(-1), LEAVE);
	});

	it("第一次 Ctrl+C 只提示，不离开备用屏", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			pressCtrlC(input);

			assert.ok((output.chunks.at(-1) ?? "").includes(HINT));
			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("提示只保留一小段时间", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			pressCtrlC(input);
			assert.ok((output.chunks.at(-1) ?? "").includes(HINT));

			t.mock.timers.tick(2000);

			assert.equal((output.chunks.at(-1) ?? "").includes(HINT), false);
		} finally {
			exitTui(input);
		}
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
			assert.equal(lines[9], BORDER.repeat(40));
			assert.equal(lines[10], CURSOR);
			assert.equal(lines[11], BORDER.repeat(40));
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
			assert.equal(lines[3], BORDER.repeat(20));
			assert.equal(lines[4], CURSOR);
			assert.equal(lines[5], BORDER.repeat(20));
		} finally {
			exitTui(input);
		}
	});

	it("输入框一有内容，品牌名与版本号就隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("a"));

			const typed = frameLines(output);
			assert.equal(typed.join("\n").includes("Reins"), false);
			assert.equal(typed.join("\n").includes("v1.2.3"), false);
			assert.equal(typed[10], `a${CURSOR}`);
		} finally {
			exitTui(input);
		}
	});

	it("退格清空输入后品牌名与版本号恢复", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from([0x7f]));

			const lines = frameLines(output);
			assert.equal(lines[10], `ab${CURSOR}`);
			assert.equal(lines.join("\n").includes("Reins"), false);

			input.emit("data", Buffer.from([0x7f]));
			input.emit("data", Buffer.from([0x7f]));
			const cleared = frameLines(output);
			assert.ok(cleared.join("\n").includes("Reins"));
			assert.ok(cleared.join("\n").includes("v1.2.3"));
			assert.equal(cleared[10], CURSOR);
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
