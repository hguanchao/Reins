import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import {
	FakeInput,
	FakeOutput,
	createFakeAgent,
	FOOTER_INFO,
	exitTui,
	frameLines,
	plain,
} from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import { incompleteEscapeStart } from "../../../src/tui/input/dispatch.ts";

/** 起一套最小界面：只关心输入框里的文字与提交结果。 */
function startTui(t: TestContext): {
	readonly input: FakeInput;
	readonly output: FakeOutput;
	readonly agent: ReturnType<typeof createFakeAgent>;
	readonly running: Promise<number>;
} {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const input = new FakeInput();
	const output = new FakeOutput();
	output.columns = 60;
	output.rows = 12;
	const agent = createFakeAgent();
	const running = runTui({
		version: "1.2.3",
		info: FOOTER_INFO,
		agent: agent.runtime,
		stdin: input,
		stdout: output,
	});
	return { input, output, agent, running };
}

function screenText(output: FakeOutput): string {
	return frameLines(output).map(plain).join("\n");
}

describe("未完成的转义序列", () => {
	it("只把确实还缺后续字节的尾巴算作未完成", () => {
		assert.equal(incompleteEscapeStart("hello"), -1);
		// 单独的 ESC 就是 Esc 键，不能延后
		assert.equal(incompleteEscapeStart("hello\x1b"), -1);
		assert.equal(incompleteEscapeStart("hello\x1b["), 5);
		assert.equal(incompleteEscapeStart("hello\x1b[20"), 5);
		assert.equal(incompleteEscapeStart("hello\x1b[1;5"), 5);
		assert.equal(incompleteEscapeStart("hello\x1bO"), 5);
		// 完整序列与普通文本不受影响
		assert.equal(incompleteEscapeStart("hello\x1b[A"), -1);
		assert.equal(incompleteEscapeStart("hello\x1b[201~"), -1);
		assert.equal(incompleteEscapeStart("hello\x1b[<0;1;1M"), -1);
	});
});

describe("跨块输入", () => {
	it("粘贴结束标记被切断时仍能结束粘贴并提交", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("\x1b[200~hello\x1b[20"));
			input.emit("data", Buffer.from("1~"));

			const text = screenText(output);
			assert.ok(text.includes("hello"));
			assert.equal(text.includes("[20"), false);

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["hello"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("方向键序列被切断时仍按一个按键处理", async (t) => {
		const { input, output, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("ab\x1b["));
			input.emit("data", Buffer.from("D"));
			input.emit("data", Buffer.from("X"));

			const text = screenText(output);
			assert.ok(text.includes("aXb"));
			assert.equal(text.includes("[D"), false);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("结束标记丢失时超时后键盘恢复可用", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("\x1b[200~abc"));
			// 粘贴态卡住期间回车不会提交
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, []);

			t.mock.timers.tick(10_000);
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["abc"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});
});
