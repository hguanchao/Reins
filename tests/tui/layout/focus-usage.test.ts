import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOCUS, BLUR, INFO, BORDER, FOOTER_INFO, exitTui, rawFrame, frameLines, cursorAt, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";

describe("焦点、状态与用量", () => {
	it("启动时回填历史并隐藏启动画面", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			history: [{ prompt: "old question", response: ["old answer"] }],
			stdin: input,
			stdout: output,
		});

		try {
			const main = frameLines(output).slice(0, 6).map(plain).join("\n");
			assert.ok(main.includes(" › old question"));
			assert.ok(main.includes("old answer"));
			assert.equal(main.includes("v1.2.3"), false);
			assert.equal(main.includes("████"), false);
		} finally {
			exitTui(input);
		}
	});

	it("尺寸变化时按新尺寸重画", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			output.columns = 20;
			output.rows = 7;
			output.emit("resize");

			const lines = frameLines(output);
			assert.equal(lines.length, 7);
			assert.equal(plain(lines[0] ?? "").trimEnd(), "████  █████  █████");
			assert.equal(lines.join("\n").includes("v1.2.3"), false);
			assert.equal(plain(lines[3] ?? ""), BORDER.repeat(20));
			assert.equal(plain(lines[4] ?? ""), " › ");
			assert.equal(plain(lines[5] ?? ""), BORDER.repeat(20));
			assert.equal(plain(lines[6] ?? ""), "📊 100K / 1M");
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
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("\x1b[O"));
			let frame = rawFrame(output);
			assert.ok(frame.includes(BLUR));
			assert.ok(frameLines(output)[9]?.startsWith(BLUR));
			assert.ok(frameLines(output)[11]?.startsWith(INFO));
			assert.equal(frame.includes("\x1b[?25h"), false);
			assert.equal(plain(frameLines(output)[9] ?? ""), " › ");

			input.emit("data", Buffer.from("\x1b[I"));
			frame = rawFrame(output);
			assert.ok(frame.includes(FOCUS));
			assert.ok(frameLines(output)[9]?.startsWith(FOCUS));
			assert.equal(plain(frameLines(output)[9] ?? ""), " › ");
			assert.ok(cursorAt(output, 10, 4));
		} finally {
			exitTui(input);
		}
	});

	it("点击输入框外失去焦点，点击输入框内恢复", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			// 12 行终端里页脚是 8-12 行，点第 5 行算输入框外
			input.emit("data", Buffer.from("\x1b[<0;5;5M"));
			let frame = rawFrame(output);
			assert.ok(frame.includes(BLUR));
			assert.ok(frameLines(output)[9]?.startsWith(BLUR));
			assert.equal(frame.includes("\x1b[?25h"), false);
			assert.equal(plain(frameLines(output)[9] ?? ""), " › ");

			// 点页脚信息行不算点输入框，焦点保持在外
			input.emit("data", Buffer.from("\x1b[<0;5;12M"));
			frame = rawFrame(output);
			assert.ok(frame.includes(BLUR));
			assert.equal(frame.includes("\x1b[?25h"), false);

			// 点输入行（第 10 行）重新获得焦点
			input.emit("data", Buffer.from("\x1b[<0;5;10M"));
			frame = rawFrame(output);
			assert.ok(frame.includes(FOCUS));
			assert.ok(frameLines(output)[9]?.startsWith(FOCUS));
			assert.equal(plain(frameLines(output)[9] ?? ""), " › ");
			assert.ok(cursorAt(output, 10, 4));
		} finally {
			exitTui(input);
		}
	});

	it("输入框失焦后按回车先抢回焦点，这一下不提交", () => {
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
			// 先打一句话，再点到对话流上让输入框失焦
			input.emit("data", Buffer.from("hello"));
			input.emit("data", Buffer.from("\x1b[<0;5;5M"));
			let frame = rawFrame(output);
			assert.ok(frame.includes(BLUR));
			assert.equal(frame.includes("\x1b[?25h"), false);

			// 回车把焦点抢回来：边框转强调色、光标出现，但已经打好的内容没有被提交
			input.emit("data", Buffer.from("\r"));
			frame = rawFrame(output);
			assert.ok(frame.includes(FOCUS));
			assert.ok(cursorAt(output, 10, 9));
			assert.equal(plain(frameLines(output)[7] ?? "").includes("Waiting for model"), false);

			// 焦点回来之后再按一次才真正提交
			input.emit("data", Buffer.from("\r"));
			assert.ok(plain(frameLines(output)[7] ?? "").includes("Waiting for model"));
		} finally {
			exitTui(input);
		}
	});

	it("输入框一有输入，启动标志与版本号就隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("a"));

			const typed = frameLines(output);
			const main = typed.slice(0, 6).join("\n");
			assert.equal(main.includes("v1.2.3"), false);
			assert.equal(main.includes("████"), false);
			assert.equal(plain(typed[9] ?? ""), " › a");
			assert.ok(cursorAt(output, 10, 5));
		} finally {
			exitTui(input);
		}
	});

	it("输入斜杠命令时启动标志与版本号也隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/"));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("v1.2.3"), false);
			assert.equal(text.includes("████"), false);
			assert.ok(text.includes("/help"));
		} finally {
			exitTui(input);
		}
	});

	it("回车后提示在顶部，状态行开始等待", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
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

			const lines = frameLines(output);
			assert.equal(lines.length, 12);
			const prompt = plain(lines[1] ?? "");
			assert.ok(prompt.startsWith(" › hello"));
			assert.equal(prompt.length, 60);
			assert.ok((lines[0] ?? "").includes("\x1b[48;2;22;25;29m"));
			assert.ok((lines[1] ?? "").includes("\x1b[48;2;22;25;29m"));
			assert.ok((lines[2] ?? "").includes("\x1b[48;2;22;25;29m"));
			assert.ok((lines[1] ?? "").includes("\x1b[38;2;230;233;237m"));
			assert.equal((lines[3] ?? "").includes("\x1b[48;2;22;25;29m"), false);
			const status = plain(lines[7] ?? "");
			assert.ok(status.startsWith(" ⠋ Waiting for model…  0.0s"));
			assert.ok(status.endsWith("0.0s  ⇣0"));
			assert.equal(status.length, 58);
			assert.ok((lines[7] ?? "").includes("\x1b[38;2;"));
			assert.equal(plain(lines[9] ?? ""), " › ");
			assert.ok(cursorAt(output, 10, 4));
		} finally {
			exitTui(input);
		}
	});

	it("状态行耗时按渲染时刻现算，不依赖刷新帧累加", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
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
			t.mock.timers.tick(100);

			// 只推进时钟，不再触发刷新帧：下一次重绘仍要显示真实经过的时间
			t.mock.timers.setTime(Date.now() + 5_000);
			output.emit("resize");

			const status =
				frameLines(output)
					.map(plain)
					.find((line) => line.includes("Waiting for model")) ?? "";
			assert.ok(status.includes("5.1s"), status);
			assert.ok(status.endsWith("5.1s  ⇣0"), status);
		} finally {
			exitTui(input);
		}
	});

	it("运行时状态按 Waiting、Thinking、Writing 推进", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
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

			t.mock.timers.tick(300);
			let status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for model…"));
			assert.ok(status.includes("0.3s"));
			assert.ok(status.endsWith("0.3s  ⇣0"));

			agent.emit({ type: "reasoning_delta", text: "thinking" });
			t.mock.timers.tick(100);
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Thinking…"));
			assert.ok(status.includes("0.1s"));
			assert.ok(status.endsWith("0.4s  ⇣0"));

			agent.emit({ type: "text_delta", text: "hello from the model" });
			t.mock.timers.tick(100);
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Writing response…"));
			assert.ok(status.includes("0.1s"));
			assert.ok(status.includes("0.5s  ⇣"));
		} finally {
			exitTui(input);
		}
	});

	it("重试时状态行说明第几次", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "retrying", attempt: 2, maxAttempts: 5, reason: "connection reset" });

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Retrying 2/5 · connection reset"));
			assert.equal(text.includes("connection reset · Retrying"), false);
		} finally {
			exitTui(input);
		}
	});

	it("notify=bell 时一轮结束响铃", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			notify: "bell",
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			assert.equal(output.chunks.some((chunk) => chunk.includes("\x07")), false);

			await agent.finish();
			assert.ok(output.chunks.some((chunk) => chunk.includes("\x07")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("notify=auto 只在终端失焦时响铃", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			notify: "auto",
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("one\r"));
			await agent.finish();
			assert.equal(output.chunks.some((chunk) => chunk.includes("\x07")), false);

			input.emit("data", Buffer.from("\x1b[O"));
			input.emit("data", Buffer.from("two\r"));
			await agent.finish();
			assert.ok(output.chunks.some((chunk) => chunk.includes("\x07")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("notify=auto 点击对话流后仍视为终端在前台", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			notify: "auto",
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("one\r"));
			await agent.finish();
			assert.equal(output.chunks.some((chunk) => chunk.includes("\x07")), false);

			input.emit("data", Buffer.from("two\r"));
			// 点对话流只让输入框失焦，终端窗口仍在前台，回合结束不该响铃
			input.emit("data", Buffer.from("\x1b[<0;3;2M\x1b[<0;3;2m"));
			await agent.finish();
			assert.equal(
				output.chunks.some((chunk) => chunk.includes("\x07")),
				false,
				"点击对话流不应被当成终端失焦",
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("每记一笔用量页脚就更新，不必等整轮结束", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		// 页脚数字由装配处提供；刷新时换成新的一批，模拟会话里多了一笔用量
		let info = { ...FOOTER_INFO, contextUsed: 100_000, cacheHitRate: 0.5 };
		const agent = createFakeAgent(() => {
			info = { ...info, contextUsed: 440_000, cacheHitRate: 0.75 };
		});
		void runTui({ version: "1.2.3", info: () => info, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			const before = frameLines(output).map(plain).join("\n");
			assert.ok(before.includes("100K / 1M"));
			assert.ok(before.includes("⚡ 50%"));

			agent.emit({ type: "usage_recorded", kind: "turn", tokens: 440_000 });
			t.mock.timers.tick(1);

			// 轮次还没结束，页脚已经是最新的一笔
			const after = frameLines(output).map(plain).join("\n");
			assert.ok(after.includes("440K / 1M"));
			assert.ok(after.includes("⚡ 75%"));
			assert.ok(after.includes("Waiting for model…"));
		} finally {
			exitTui(input);
		}
	});

	it("状态行 token 是本轮累计用量，压缩用量不计入", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));

			agent.emit({ type: "usage_recorded", kind: "turn", tokens: 1200 });
			t.mock.timers.tick(100);
			let status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("⇣1.2K"));

			agent.emit({ type: "usage_recorded", kind: "turn", tokens: 800 });
			t.mock.timers.tick(100);
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("⇣2K"));

			// 压缩请求是压缩成本，不属于这一轮对话的 token 用量
			agent.emit({ type: "usage_recorded", kind: "compact", tokens: 5000 });
			t.mock.timers.tick(100);
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("⇣2K"));
			assert.equal(status.includes("⇣7K"), false);
		} finally {
			exitTui(input);
		}
	});
});
