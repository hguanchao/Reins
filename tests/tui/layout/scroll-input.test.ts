import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, BORDER, LEAVE, FOOTER_INFO, exitTui, lastFrame, frameLines, cursorAt, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";
import { THEME } from "#src/tui/render/theme.ts";

describe("滚动与输入", () => {
	it("回复在提示下方增长并保持提示吸顶", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join("\n"),
			});
			t.mock.timers.tick(100);

			const lines = frameLines(output);
			const main = lines.slice(0, 6).map(plain);
			assert.ok(main[1]?.startsWith(" › hello"));
			assert.equal(main[0]?.includes("›"), false);
			assert.equal(main[2]?.includes("›"), false);
			assert.equal(main[3]?.includes("›"), false);
			assert.ok(main.slice(4).join("\n").includes("line"));

			const status = plain(lines[7] ?? "");
			assert.ok(status.includes("Writing response…"));
			assert.ok(status.includes("⇣"));
			assert.equal(plain(lines[9] ?? ""), " › ");
		} finally {
			exitTui(input);
		}
	});

	it("滚轮和拖动可以滚动对话流", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join("\n"),
			});
			t.mock.timers.tick(100);

			const bottom = frameLines(output).slice(0, 6).map(plain);
			assert.ok(bottom.slice(2).join("\n").includes("line 16"));

			// 拖到顶部，看到最早的回复
			input.emit("data", Buffer.from("\x1b[<0;40;1M"));
			const top = frameLines(output).slice(0, 6).map(plain);
			assert.ok(top[1]?.startsWith(" › hello"));
			assert.ok(top.slice(2).join("\n").includes("line 1"));

			// 拖回底部
			input.emit("data", Buffer.from("\x1b[<32;40;7M"));
			const back = frameLines(output).slice(0, 6).map(plain);
			assert.ok(back.slice(2).join("\n").includes("line 16"));

			// 松开后滚轮向上，再向下回到跟随
			input.emit("data", Buffer.from("\x1b[<0;40;7m"));
			input.emit("data", Buffer.from("\x1b[<64;20;4M"));
			const scrolled = frameLines(output).slice(0, 6).map(plain);
			assert.ok(scrolled[1]?.startsWith(" › hello"));
			assert.notEqual(scrolled.join("\n"), back.join("\n"));

			input.emit("data", Buffer.from("\x1b[<65;20;4M"));
			const followed = frameLines(output).slice(0, 6).map(plain);
			assert.ok(followed.slice(2).join("\n").includes("line 16"));
		} finally {
			exitTui(input);
		}
	});

	it("上滚后出现置底按钮，点击回到底部", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join("\n"),
			});
			t.mock.timers.tick(100);

			// 贴在底部时没有可置底的东西，不画按钮
			assert.equal(lastFrame(output).includes("\x1b[6;18H"), false);

			// 拖到顶部后按钮出现在对话流最后一行底部居中，默认是弱色
			input.emit("data", Buffer.from("\x1b[<0;40;1M"));
			input.emit("data", Buffer.from("\x1b[<0;40;1m"));
			const idle = `\x1b[6;18H${THEME.surface}${THEME.textSubtle}  ▼  ${THEME.reset}`;
			assert.ok(lastFrame(output).includes(idle));

			// 指针移进按钮范围后高亮
			input.emit("data", Buffer.from("\x1b[<35;19;6M"));
			assert.ok(lastFrame(output).includes(`\x1b[6;18H${THEME.surface}${THEME.accent}  ▼  ${THEME.reset}`));

			// 移出去恢复弱色
			input.emit("data", Buffer.from("\x1b[<35;5;5M"));
			assert.ok(lastFrame(output).includes(idle));

			// 点按钮左侧的命中扩展区也算命中：小目标留出容错
			input.emit("data", Buffer.from("\x1b[<0;17;6M"));
			const back = frameLines(output).slice(0, 6).map(plain);
			assert.ok(back.slice(2).join("\n").includes("line 16"));
			assert.equal(lastFrame(output).includes("\x1b[6;18H"), false);
		} finally {
			exitTui(input);
		}
	});

	it("发送第二条后新提示落在顶部，旧内容留在上方", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("one\r"));
			agent.emit({ type: "text_delta", text: "first response" });
			t.mock.timers.tick(100);
			await agent.finish();

			input.emit("data", Buffer.from("two\r"));

			const latest = frameLines(output).slice(0, 6).map(plain);
			assert.ok(latest[1]?.startsWith(" › two"));

			// 拖到顶部可以看到旧提示
			input.emit("data", Buffer.from("\x1b[<0;40;1M"));
			const top = frameLines(output).slice(0, 6).map(plain);
			assert.ok(top[1]?.startsWith(" › one"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("空输入回车不发送", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			const written = output.chunks.length;
			input.emit("data", Buffer.from("\r"));
			assert.equal(output.chunks.length, written);
		} finally {
			exitTui(input);
		}
	});

	it("键盘滚动对话流，滚上去后不自动跟随，可用 PageDown 回底", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 50;
		output.rows = 12;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
			});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("line 30"));

			input.emit("data", Buffer.from("\x1b[5~"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line 30"), false);

			agent.emit({ type: "text_delta", text: "\ntail-line\n" });
			t.mock.timers.tick(100);
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("tail-line"), false);

			for (let index = 0; index < 10; index += 1) {
				input.emit("data", Buffer.from("\x1b[6~"));
			}
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("tail-line"));
		} finally {
			exitTui(input);
		}
	});

	it("输入支持左右移动与中间插入", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b[D"));
			input.emit("data", Buffer.from("X"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" › abXc"));
			assert.ok(cursorAt(output, 10, 7));
		} finally {
			exitTui(input);
		}
	});

	it("输入历史用上下键回填，回到草稿", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("first\r"));
			await agent.finish();

			input.emit("data", Buffer.from("\x1b[A"));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" › first"));

			input.emit("data", Buffer.from("\x1b[B"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" › "));
		} finally {
			exitTui(input);
		}
	});

	it("多行粘贴按行显示且不提交", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("\x1b[200~line1\r\nline2\x1b[201~"));

			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.startsWith(" › line1")));
			assert.ok(lines.some((line) => line.startsWith("   line2")));
			assert.ok(cursorAt(output, 10, 9));
			assert.equal(lines.join("\n").includes("Waiting for model…"), false);
		} finally {
			exitTui(input);
		}
	});

	it("粘贴正文里的转义序列不会进入输入框", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("\x1b[200~safe\x1b[31mred\x1b[0m\x1b[201~"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" › safered"));
		} finally {
			exitTui(input);
		}
	});

	it("终端过小时保留正在编辑的输入行并提示内容被裁掉", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 40;
		output.rows = 8;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			// 用 Shift+Enter 逐行输入而不是粘贴：多行粘贴会被折叠成一行标记，撑不出溢出
			for (let line = 1; line <= 7; line += 1) {
				input.emit("data", Buffer.from(`long-line-${line}`));
				if (line < 7) input.emit("data", Buffer.from("\x1b[13;2u"));
			}
			t.mock.timers.tick(100);

			const frame = frameLines(output).map(plain).join("\n");
			assert.ok(frame.includes("Terminal too small"), "应提示内容被裁掉");
			assert.ok(frame.includes("long-line-7"), "光标所在行仍应可见");
		} finally {
			exitTui(input);
		}
	});

	it("还没输入就按退格，空启动画面不受影响", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			const written = output.chunks.length;
			input.emit("data", Buffer.from([0x7f]));

			assert.equal(output.chunks.length, written);
			const lines = frameLines(output);
			// 空启动画面不因退格重画或错位:主区域仍是留白,页脚边框完好
			for (let row = 0; row < 6; row += 1) assert.equal(plain(lines[row] ?? ""), "");
			assert.equal(plain(lines[8] ?? ""), BORDER.repeat(40));
		} finally {
			exitTui(input);
		}
	});

	it("宽字符输入后光标停在字符之后", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("你好"));

			const lines = frameLines(output);
			assert.equal(plain(lines[9] ?? ""), " › 你好");
			assert.ok(cursorAt(output, 10, 8));
		} finally {
			exitTui(input);
		}
	});

	it("退格清空输入后启动标志与版本号仍然隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from([0x7f]));

			const lines = frameLines(output);
			assert.equal(plain(lines[9] ?? ""), " › ab");
			assert.equal(lines.slice(0, 6).join("\n").includes("v1.2.3"), false);
			assert.equal(lines.slice(0, 6).join("\n").includes("████"), false);
			assert.ok(cursorAt(output, 10, 6));

			input.emit("data", Buffer.from([0x7f]));
			input.emit("data", Buffer.from([0x7f]));
			const cleared = frameLines(output);
			assert.equal(cleared.slice(0, 6).join("\n").includes("v1.2.3"), false);
			assert.equal(cleared.slice(0, 6).join("\n").includes("████"), false);
			assert.equal(plain(cleared[9] ?? ""), " › ");
			assert.ok(cursorAt(output, 10, 4));
		} finally {
			exitTui(input);
		}
	});

	it("方向键等转义序列不会进入输入框", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

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
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

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
