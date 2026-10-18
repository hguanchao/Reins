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

describe("全屏布局", () => {
	it("进入备用屏，按当前尺寸绘制，Ctrl+C 后恢复", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			assert.equal(output.chunks[0], ENTER);
			assert.equal(input.rawMode, true);
			assert.equal(input.resumed, true);
		} finally {
			input.emit("data", Buffer.from([3]));
		}

		assert.equal(await running, 0);
		assert.equal(input.rawMode, false);
		assert.equal(input.resumed, false);
		assert.equal(output.chunks.at(-1), LEAVE);
	});

	it("主区域在页脚之上居中", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			const frame = output.chunks[1] ?? "";
			assert.ok(frame.startsWith(CLEAR));
			const lines = frame.slice(CLEAR.length).split("\r\n");

			assert.equal(lines.length, 12);
			assert.equal(lines[4], `${" ".repeat(17)}Reins`);
			assert.equal(lines[5], `${" ".repeat(17)}1.2.3`);
			assert.equal(lines[11], "");
		} finally {
			input.emit("data", Buffer.from([3]));
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

			const frame = output.chunks.at(-1) ?? "";
			const lines = frame.slice(CLEAR.length).split("\r\n");
			assert.equal(lines.length, 6);
			assert.equal(lines[1], `${" ".repeat(7)}Reins`);
			assert.equal(lines[2], `${" ".repeat(7)}1.2.3`);
		} finally {
			input.emit("data", Buffer.from([3]));
		}
	});

	it("普通按键不退出", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", stdin: input, stdout: output });

		try {
			const written = output.chunks.length;
			input.emit("data", Buffer.from("x"));

			assert.equal(output.chunks.length, written);
			assert.equal(input.rawMode, true);
		} finally {
			input.emit("data", Buffer.from([3]));
		}
	});
});
