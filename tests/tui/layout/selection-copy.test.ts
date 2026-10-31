import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	FakeInput,
	FakeOutput,
	createFakeAgent,
	FOOTER_INFO,
	exitTui,
	frameLines,
	plain,
} from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";
import { THEME } from "#src/tui/render/theme.ts";

/** 在对话流里找到一段文字，返回它的屏幕行与起止列（1 基）。 */
function locate(
	output: FakeOutput,
	needle: string,
	from: number,
): { readonly row: number; readonly start: number; readonly end: number } {
	const lines = frameLines(output).map(plain);
	const rowIndex = lines.findIndex((line) => line.includes(needle));
	assert.ok(rowIndex >= 0, `找不到 ${needle}`);
	const line = lines[rowIndex] ?? "";
	const begin = line.indexOf(needle, from);
	assert.ok(begin >= 0, `找不到 ${needle} 的列`);
	return { row: rowIndex + 1, start: begin + 1, end: begin + needle.length };
}

describe("鼠标拖选复制", () => {
	it("拖动一段文字，松开后复制到系统剪贴板", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const copied: string[] = [];
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			clipboard: {
				copy: (text) => {
					copied.push(text);
					return true;
				},
			},
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({ type: "text_delta", text: "AA hello world BB" });
			t.mock.timers.tick(100);

			const span = locate(output, "hello world", 0);
			input.emit(
				"data",
				Buffer.from(`\x1b[<0;${span.start};${span.row}M\x1b[<32;${span.end};${span.row}M`),
			);
			t.mock.timers.tick(100);
			// 拖动过程中选区底色
			assert.ok(frameLines(output).some((line) => line.includes(THEME.selectionBg)));

			input.emit("data", Buffer.from(`\x1b[<0;${span.end};${span.row}m`));
			t.mock.timers.tick(100);
			// 复制走异步剪贴板：让出一次事件循环再断言状态行
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.deepEqual(copied, ["hello world"]);
			let text = frameLines(output).map(plain).join("\n");
			// 提示占用 token 位置，期间不显示 token 计量
			assert.ok(text.includes("Copied!"));
			assert.equal(text.includes("⇣"), false);

			// 自动消失后 token 计量回显
			t.mock.timers.tick(1_500);
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Copied!"), false);
			assert.ok(text.includes("⇣0"));
		} finally {
			exitTui(input);
		}
	});

	it("没有系统剪贴板写入时退到 OSC 52", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({ type: "text_delta", text: "AA hello world BB" });
			t.mock.timers.tick(100);

			const span = locate(output, "hello world", 0);
			input.emit(
				"data",
				Buffer.from(
					`\x1b[<0;${span.start};${span.row}M` +
						`\x1b[<32;${span.end};${span.row}M` +
						`\x1b[<0;${span.end};${span.row}m`,
				),
			);
			t.mock.timers.tick(100);
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.ok(
				output.chunks.some((chunk) =>
					chunk.includes(`\x1b]52;c;${Buffer.from("hello world").toString("base64")}\x07`),
				),
			);
			const text = frameLines(output).map(plain).join("\n");
			// OSC 52 只是把序列写给终端，终端是否接住无法确认，不能承诺「已复制」
			assert.ok(text.includes("Copy sent to terminal"));
		} finally {
			exitTui(input);
		}
	});

	it("松开事件丢失后，键盘输入或鼠标移动会清掉残留选区", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({ type: "text_delta", text: "AA hello world BB" });
			t.mock.timers.tick(100);
			const span = locate(output, "hello world", 0);

			const drag =
				`\x1b[<0;${span.start};${span.row}M` + `\x1b[<32;${span.end};${span.row}M`;
			input.emit("data", Buffer.from(drag));
			t.mock.timers.tick(100);
			assert.ok(frameLines(output).some((line) => line.includes(THEME.selectionBg)));

			// 键盘输入表示已经离开拖选
			input.emit("data", Buffer.from("x"));
			t.mock.timers.tick(100);
			assert.equal(frameLines(output).some((line) => line.includes(THEME.selectionBg)), false);

			// 再拖一次，这次用没有按键的指针移动收尾
			input.emit("data", Buffer.from(drag));
			t.mock.timers.tick(100);
			assert.ok(frameLines(output).some((line) => line.includes(THEME.selectionBg)));
			input.emit("data", Buffer.from(`\x1b[<35;${span.end};${span.row}M`));
			t.mock.timers.tick(100);
			assert.equal(frameLines(output).some((line) => line.includes(THEME.selectionBg)), false);
		} finally {
			exitTui(input);
		}
	});

	it("原地点击不复制", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const copied: string[] = [];
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			clipboard: {
				copy: (text) => {
					copied.push(text);
					return true;
				},
			},
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({ type: "text_delta", text: "AA hello world BB" });
			t.mock.timers.tick(100);

			const span = locate(output, "hello world", 0);
			input.emit(
				"data",
				Buffer.from(`\x1b[<0;${span.start};${span.row}M\x1b[<0;${span.start};${span.row}m`),
			);
			t.mock.timers.tick(100);

			assert.deepEqual(copied, []);
		} finally {
			exitTui(input);
		}
	});

	it("停在边缘不动也会继续滚，滚到底自动停", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			clipboard: { copy: () => true },
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 400 }, (_, index) => `word-${index + 1}`).join(" "),
			});
			t.mock.timers.tick(100);
			// 跳到顶部：PgUp 连按到页顶（超出会夹住）
			for (let index = 0; index < 8; index += 1) {
				input.emit("data", Buffer.from("\x1b[5~"));
			}
			t.mock.timers.tick(100);

			const content = (): string => frameLines(output).map(plain).slice(0, 14).join("\n");

			// 只发一次拖动事件，之后不再有任何鼠标输入
			input.emit("data", Buffer.from("\x1b[<0;3;2M\x1b[<32;3;14M"));
			t.mock.timers.tick(60);
			const afterDrag = content();

			t.mock.timers.tick(300);
			const afterTicks = content();
			// 没有新的移动事件，画面仍在往前走：这是定时器在滚
			assert.notEqual(afterTicks, afterDrag);

			// 滚到底之后自己停下，不会一直空转
			t.mock.timers.tick(2_000);
			const atBottom = content();
			t.mock.timers.tick(2_000);
			assert.equal(content(), atBottom);
		} finally {
			exitTui(input);
		}
	});

	it("拖到内容区底边时自动滚动，能选到屏幕外的内容", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const copied: string[] = [];
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			clipboard: {
				copy: (text) => {
					copied.push(text);
					return true;
				},
			},
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			// 用长到折行的正文：软换行才会真的把内容顶出屏幕，一行一个词时凑不满一屏
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 400 }, (_, index) => `word-${index + 1}`).join(" "),
			});
			t.mock.timers.tick(100);

			// 先跳到顶部：跟随底部时画面本来就在最末，往下拖没有可滚的余量
			for (let index = 0; index < 8; index += 1) {
				input.emit("data", Buffer.from("\x1b[5~"));
			}
			t.mock.timers.tick(100);

			// 只看内容区：状态行的耗时每帧都在变，拿整屏比较会把「没滚动」判成滚动
			const content = (): string => frameLines(output).map(plain).slice(0, 14).join("\n");
			const before = content();

			// 从内容区顶部拖到底边：边缘滚动把画面往上推，否则后面的行永远选不到
			input.emit("data", Buffer.from("\x1b[<0;3;2M\x1b[<32;3;14M"));
			t.mock.timers.tick(100);
			assert.notEqual(content(), before);

			input.emit("data", Buffer.from("\x1b[<0;3;14m"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(copied.length, 1);
			assert.ok((copied[0] ?? "").includes("word-1"));
		} finally {
			exitTui(input);
		}
	});
});
