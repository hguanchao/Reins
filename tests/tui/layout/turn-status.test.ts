import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, WARNING, exitTui, frameLines, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";
import type { AgentRuntime } from "#src/tui/options.ts";
import type { AgentEventListener } from "#src/agent/events.ts";

describe("回合状态行", () => {
	it("/compact 立即压缩上下文，进度与结果进入对话流", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let compactCalls = 0;
		let refreshes = 0;
		let listener: AgentEventListener | undefined;
		let finishCompact: (() => void) | undefined;
		const agent: AgentRuntime = {
			runTurn: async () => {},
			refreshInfo: () => {
				refreshes += 1;
			},
			compact: (onEvent) => {
				compactCalls += 1;
				listener = onEvent;
				return new Promise<void>((resolve) => {
					finishCompact = resolve;
				});
			},
		};
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/compact\r"));
			assert.equal(compactCalls, 1);

			void listener?.({ type: "compaction_start", messages: 6, tokensBefore: 5000 });
			t.mock.timers.tick(100);
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› /compact"));
			assert.ok(text.includes("Compacting context · 6 messages · ~5000 tokens"));
			assert.ok(text.includes("Compacting context…"));

			void listener?.({ type: "compaction_end", covered: 6, tokensBefore: 5000, tokensAfter: 1200 });
			t.mock.timers.tick(100);
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Context compacted · ~5000 → ~1200 tokens"));
			assert.ok(refreshes >= 1);

			finishCompact?.();
			await new Promise<void>((resolve) => setImmediate(resolve));
			t.mock.timers.tick(2000);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Context compacted · ~5000 → ~1200 tokens"));
			assert.equal(text.includes("Done"), false);
			assert.equal(text.includes("Compacting context…"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("一轮完成后立即清空状态行，不显示 Done", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "text_delta", text: "hi" });
			t.mock.timers.tick(100);
			assert.ok(frameLines(output).map(plain).join("\n").includes("Writing response…"));

			await agent.finish();

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("hi"));
			assert.equal(text.includes("Done"), false);
			assert.equal(text.includes("Writing response…"), false);
		} finally {
			exitTui(input);
		}
	});

	it("流式增量以换行结尾时，行末内容不会丢", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "text_delta", text: "第一行结尾" });
			agent.emit({ type: "text_delta", text: "完整\n" });
			agent.emit({ type: "text_delta", text: "第二行完全" });
			agent.emit({ type: "text_delta", text: "保留\n" });
			await agent.finish();

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("第一行结尾完整"));
			assert.ok(text.includes("第二行完全保留"));
		} finally {
			exitTui(input);
		}
	});

	it("思考插在文本中间时，文本继续写回原来的块", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "text_delta", text: "我先" });
			agent.emit({ type: "reasoning_delta", text: "." });
			agent.emit({ type: "text_delta", text: "看一下项目结构。" });
			t.mock.timers.tick(100);

			const lines = frameLines(output).map(plain);
			const textRow = lines.findIndex((line) => line.includes("我先看一下项目结构。"));
			const thoughtRow = lines.findIndex((line) => line.includes("Thought for"));

			// 文本仍是一个块；迟到的思考块保留，但排在完整文本之后
			assert.ok(textRow >= 0);
			assert.ok(thoughtRow > textRow);
		} finally {
			exitTui(input);
		}
	});

	it("纯空白的思考不生成空思考块", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "reasoning_delta", text: " \n " });
			agent.emit({ type: "text_delta", text: "答案" });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Thought for"), false);
			assert.ok(text.includes("答案"));

			// 真正的思考仍然创建区块；后续文本继续写回原来的文本块
			agent.emit({ type: "reasoning_delta", text: "真正的思考" });
			agent.emit({ type: "text_delta", text: "继续" });
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Thought for"));
			assert.ok(text.includes("答案继续"));
		} finally {
			exitTui(input);
		}
	});

	it("没有压缩入口时 /compact 提示配置不可用", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			warning: WARNING,
			ready: false,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/compact\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Configuration is invalid"));
			assert.equal(text.includes("Waiting for model…"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
