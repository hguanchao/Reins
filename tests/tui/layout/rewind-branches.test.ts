import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runTui } from "../../../src/tui/layout.ts";
import type { ConversationSource } from "../../../src/tui/options.ts";
import {
	FakeInput,
	FakeOutput,
	FOOTER_INFO,
	createFakeAgent,
	exitTui,
	frameLines,
	plain,
} from "../support/harness.ts";

const CONVERSATION: ConversationSource = {
	branches: () => [
		{ id: "b1", title: "main line", time: "now", current: true },
		{ id: "b2", title: "alternate line", time: "1m ago", current: false },
	],
	selectBranch: (id) => ({
		changed: true,
		history: [{ prompt: `branch ${id}`, response: ["branch reply"] }],
		warnings: [],
	}),
	messages: () => [
		{ id: "m2", title: "#2 second question", time: "now", current: false },
		{ id: "m1", title: "#1 first question", time: "1m ago", current: false },
	],
	rewind: (id) => ({
		changed: true,
		prompt: id === "m1" ? "first question" : "second question",
		images: [],
		history: [{ prompt: "kept", response: ["kept reply"] }],
		warnings: [],
	}),
};

function screen(output: FakeOutput): string {
	return frameLines(output).map(plain).join("\n");
}

function inputLine(output: FakeOutput): string {
	return (
		frameLines(output)
			.map(plain)
			.filter((line) => line.startsWith(" › "))
			.at(-1) ?? ""
	);
}

describe("对话回退与分支", () => {
	it("/rewind 列出历史消息，回车把原文放回输入框并截断对话", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			conversation: CONVERSATION,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/rewind\r"));
			const panel = screen(output);
			assert.ok(panel.includes("second question"), "新消息排在前面");
			assert.ok(panel.includes("first question"));

			input.emit("data", Buffer.from("\r"));
			assert.equal(inputLine(output), " › second question");
			const after = screen(output);
			assert.ok(after.includes("kept reply"), "对话流换成回退后的历史");
			assert.ok(after.includes("Rewound to before the selected message"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/branches 列出分支，回车切换并重放目标分支", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			conversation: CONVERSATION,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/branches\r"));
			const panel = screen(output);
			assert.ok(panel.includes("main line"));
			assert.ok(panel.includes("alternate line"));

			// 光标从当前分支往下移到另一条
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\r"));

			const after = screen(output);
			assert.ok(after.includes("branch b2"));
			assert.ok(after.includes("branch reply"));
			assert.ok(after.includes("Switched to another branch."));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("没有会话历史时命令给出提示而不是打开空面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/rewind\r"));
			assert.ok(screen(output).includes("Conversation history is unavailable"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("一轮进行中拒绝回退", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 16;
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			conversation: CONVERSATION,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("/rewind\r"));
			assert.ok(
				screen(output).includes("/rewind is unavailable while a turn is running"),
				screen(output),
			);
			await agent.finish();
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
