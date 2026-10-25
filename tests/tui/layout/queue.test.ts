import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, MODEL_ITEMS, SESSION_ITEMS, pressCtrlC, exitTui, rawFrame, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";

describe("排队消息", () => {
	it("一轮进行中只放行 /help、/model、/effort", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			effortMenu: { current: () => "medium", select: () => ({ warnings: [], ready: true, warning: undefined }) },
			sessionMenu: { list: () => SESSION_ITEMS, select: () => ({ changed: false, history: [], warnings: [] }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(50);
			assert.ok(frameLines(output).map(plain).join("\n").includes("Waiting for model..."));

			// /model 只影响下一轮，运行中照开
			input.emit("data", Buffer.from("/model\r"));
			assert.ok(frameLines(output).map(plain).some((line) => line.includes("fengshao/")));
			input.emit("data", Buffer.from("\x1b"));

			// /effort 同理
			input.emit("data", Buffer.from("/effort\r"));
			assert.ok(frameLines(output).map(plain).some((line) => line.includes("› /effort")));
			input.emit("data", Buffer.from("\x1b"));

			// /help 打开整屏帮助页
			input.emit("data", Buffer.from("/help\r"));
			assert.equal(frameLines(output).map(plain)[0], "Reins — help");
			input.emit("data", Buffer.from("\x1b"));

			// /compact 会另起一轮，运行中仍然挡掉：对话流里不该出现这条提示，
			// 状态行要说明为什么没执行，而不是静默丢弃
			input.emit("data", Buffer.from("/compact\r"));
			const afterCompact = frameLines(output).slice(0, 6).map(plain).join("\n");
			assert.equal(afterCompact.includes("/compact"), false);
			assert.ok(
				frameLines(output)
					.map(plain)
					.join("\n")
					.includes("/compact is unavailable"),
			);

			// /session 会替换整段历史，运行中同样挡掉；Tab 也只补全，不打开菜单
			input.emit("data", Buffer.from("/session\r"));
			assert.equal(frameLines(output).map(plain).join("\n").includes("Fix the login flow"), false);
			input.emit("data", Buffer.from("\t"));
			assert.equal(frameLines(output).map(plain).join("\n").includes("Fix the login flow"), false);
		} finally {
			exitTui(input);
		}
	});

	it("一轮进行中提交的消息排进队列，本轮结束后逐条自动发送", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.rows = 16;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			assert.deepEqual(agent.prompts, ["first"]);

			// 运行中再提交：进队列，不立刻开跑，输入框清空
			input.emit("data", Buffer.from("second\r"));
			input.emit("data", Buffer.from("third\r"));
			assert.deepEqual(agent.prompts, ["first"]);
			const queuedFrame = frameLines(output).map(plain).join("\n");
			assert.ok(queuedFrame.includes("↳ second"));
			assert.ok(queuedFrame.includes("↳ third"));

			// 本轮收尾后队首自动开跑，队列里只剩一条
			await agent.finish();
			assert.deepEqual(agent.prompts, ["first", "second"]);
			const afterFirst = frameLines(output).map(plain).join("\n");
			assert.equal(afterFirst.includes("↳ second"), false);
			assert.ok(afterFirst.includes("↳ third"));

			await agent.finish();
			assert.deepEqual(agent.prompts, ["first", "second", "third"]);
			await agent.finish();
			assert.equal(frameLines(output).map(plain).join("\n").includes("↳"), false);
		} finally {
			exitTui(input);
		}
	});

	it("中止后队列不自动续发，空输入回车把队首发出去", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.rows = 16;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("second\r"));
			assert.deepEqual(agent.prompts, ["first"]);

			// 使用者中止这一轮：队列留着，不替他继续
			pressCtrlC(input);
			agent.emit({ type: "aborted" });
			await agent.finish();
			assert.deepEqual(agent.prompts, ["first"]);
			assert.ok(frameLines(output).map(plain).join("\n").includes("↳ second"));

			// 输入框空着按回车：队首顶上来
			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["first", "second"]);
			assert.equal(frameLines(output).map(plain).join("\n").includes("↳ second"), false);
		} finally {
			exitTui(input);
		}
	});

	it("Alt+Up 把最近一条排队消息拉回输入框", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.rows = 16;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		// 对话流里的用户提示也用 " › " 开头，输入行在页脚，取最后一处匹配
		const inputLine = (): string => {
			const lines = frameLines(output);
			const index = lines.findLastIndex((line) => plain(line).startsWith(" › "));
			return index < 0 ? "" : plain(lines[index] ?? "").trimEnd();
		};

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("second\r"));

			// 取回队尾一条：撤回与编辑是同一条路径
			input.emit("data", Buffer.from("\x1b[1;3A"));
			assert.equal(inputLine(), " › second");
			assert.equal(frameLines(output).map(plain).join("\n").includes("↳ second"), false);

			// 队列空了再按不做事，输入内容不被覆盖
			input.emit("data", Buffer.from("\x1b[1;3A"));
			assert.equal(inputLine(), " › second");
		} finally {
			exitTui(input);
		}
	});

	it("Alt+Down 直接丢弃队尾，不回填输入框", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.rows = 16;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("second\r"));
			input.emit("data", Buffer.from("third\r"));

			// 只丢队尾一条，输入框保持为空
			input.emit("data", Buffer.from("\x1b[1;3B"));
			const lines = frameLines(output).map(plain).join("\n");
			assert.ok(lines.includes("↳ second"));
			assert.equal(lines.includes("↳ third"), false);
			assert.equal(lines.includes("› third"), false);

			// 队列空了再按不做事
			input.emit("data", Buffer.from("\x1b[1;3B"));
			input.emit("data", Buffer.from("\x1b[1;3B"));
			assert.equal(frameLines(output).map(plain).join("\n").includes("↳"), false);
		} finally {
			exitTui(input);
		}
	});

	it("Esc 中止本轮并立即发送队首", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.rows = 16;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("second\r"));
			input.emit("data", Buffer.from("third\r"));
			assert.deepEqual(agent.prompts, ["first"]);

			// Esc 打断当前回合，队首不等下一轮就发出去
			input.emit("data", Buffer.from("\x1b"));
			agent.emit({ type: "aborted" });
			await agent.finish();
			assert.deepEqual(agent.prompts, ["first", "second"]);
			const lines = frameLines(output).map(plain).join("\n");
			assert.equal(lines.includes("↳ second"), false);
			assert.ok(lines.includes("↳ third"));
		} finally {
			exitTui(input);
		}
	});

	it("队列为空时 Esc 只中止，不额外发送", async (t) => {
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
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("\x1b"));
			agent.emit({ type: "aborted" });
			await agent.finish();
			assert.deepEqual(agent.prompts, ["first"]);
		} finally {
			exitTui(input);
		}
	});

	it("撤回排队消息时排在已输入内容之前", async (t) => {		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.rows = 16;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("second\r"));

			// 已经打了一半的字留在原处，取回的消息排在它前面
			input.emit("data", Buffer.from("half"));
			input.emit("data", Buffer.from("\x1b[1;3A"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› second"));
			assert.ok(text.includes("   half"));
		} finally {
			exitTui(input);
		}
	});

	it("切换会话时清空队列", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.rows = 16;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: true, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("second\r"));
			assert.ok(frameLines(output).map(plain).join("\n").includes("↳ second"));

			// 先中止让这一轮收尾：运行中 /session 是被挡下的，切不了会话
			pressCtrlC(input);
			agent.emit({ type: "aborted" });
			await agent.finish();
			assert.ok(frameLines(output).map(plain).join("\n").includes("↳ second"));

			// /session 会换掉整段对话，排队消息属于旧会话
			input.emit("data", Buffer.from("/session fedcba9876543210\r"));
			assert.equal(frameLines(output).map(plain).join("\n").includes("↳ second"), false);
			assert.deepEqual(agent.prompts, ["first"]);
		} finally {
			exitTui(input);
		}
	});

	it("运行中切模型，确认块等这一轮结束再落进对话流", async (t) => {		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		// 终端够高，确认块和当前轮能同时看见
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "text_delta", text: "working..." });
			t.mock.timers.tick(100);

			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\r"));
			t.mock.timers.tick(10);

			// 这一轮还没结束：确认块先排队，免得被持续输出顶走
			let lines = frameLines(output).map(plain);
			assert.equal(lines.some((line) => line.includes("Model switched")), false);

			await agent.finish();
			t.mock.timers.tick(10);

			lines = frameLines(output).map(plain);
			const switched = lines.findIndex((line) => line.includes("Model switched"));
			const prompt = lines.findIndex((line) => line.includes("hello"));

			assert.ok(switched >= 0, "一轮结束后应落下确认块");
			// 运行中切换要说清生效时机，否则页脚已经变了、这一轮却还在用旧模型
			assert.ok(lines.join("\n").includes("(from the next turn)"));
			// 落在这一轮之后：位置在末尾，时间顺序也对
			assert.ok(switched > prompt, `确认块应排在当前轮之后：switched=${switched} prompt=${prompt}`);
		} finally {
			exitTui(input);
		}
	});

	it("重试时状态行说明原因", async (t) => {
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
			agent.emit({ type: "retrying", attempt: 1, maxAttempts: 5, reason: "Rate limited" });
			t.mock.timers.tick(100);

			assert.ok(
				frameLines(output).map(plain).join("\n").includes("Retrying (1/5): Rate limited..."),
			);
			// 重试用警告色，与「正在进行」的强调色分开：它不是正常推进，但也没失败
			assert.ok(rawFrame(output).includes("\x1b[38;2;224;175;104m"));
		} finally {
			exitTui(input);
		}
	});
});
