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
	pressCtrlC,
} from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";
import { incompleteEscapeStart } from "#src/tui/input/dispatch.ts";

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

	it("Shift+Enter 换行后回车才提交", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("a\x1b[13;2ub\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["a\nb"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("kitty 协议下的 Ctrl+C 仍然能退出", async (t) => {
		const { input, running } = startTui(t);
		input.emit("data", Buffer.from("\x1b[99;5u"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		input.emit("data", Buffer.from("\x1b[99;5u"));
		assert.equal(await running, 0);
	});
});

describe("多行输入与翻历史的分派", () => {
	it("多行草稿在边界行按方向键不翻历史", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			// 先提交一条进历史
			input.emit("data", Buffer.from("alpha\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			await agent.finish();
			assert.deepEqual(agent.prompts, ["alpha"]);
			// 粘贴两行草稿，光标在第二行末尾
			input.emit("data", Buffer.from("\x1b[200~x\ny\x1b[201~"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			// ↑ 移到第一行；再按 ↑ 已在首行——方案 A 下停住，不落历史
			input.emit("data", Buffer.from("\x1b[A"));
			input.emit("data", Buffer.from("\x1b[A"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			// 若误翻历史，这里提交的会是 "alpha"
			assert.deepEqual(agent.prompts, ["alpha", "x\ny"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("多行中间按方向键移动光标后可继续编辑", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("\x1b[200~x\ny\x1b[201~"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			// ↑ 从 y 行尾移到 x 行尾（列保持），补一个感叹号
			input.emit("data", Buffer.from("\x1b[A"));
			input.emit("data", Buffer.from("!"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["x!\ny"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("单行时方向键仍翻历史", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("alpha\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			await agent.finish();
			input.emit("data", Buffer.from("zz"));
			input.emit("data", Buffer.from("\x1b[A"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			// zz 被历史里的 alpha 替换后提交
			assert.deepEqual(agent.prompts, ["alpha", "alpha"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});
});

describe("Esc 清空输入框", () => {
	it("第一次 Esc 只提示再按一次，草稿不会直接消失", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(screenText(output).includes("Esc again to clear"));

			// 没有第二次 Esc：继续输入应该接在 abc 后面，而不是从空白开始
			input.emit("data", Buffer.from("hi\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["abchi"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("两次 Esc 超过确认窗口就重新计数", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b"));
			t.mock.timers.tick(900);
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("hi\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			// 第二次只是重新武装：输入框里还是 abc 加 hi
			assert.deepEqual(agent.prompts, ["abchi"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("连按两次 Esc 清空输入框，并给出撤销路径", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(screenText(output).includes("Input cleared · Ctrl+Z to undo"));

			input.emit("data", Buffer.from("hi\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["hi"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("输入为空时 Esc 不产生副作用", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("ok\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["ok"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("菜单打开时 Esc 先关菜单，再按两次才清空", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("/he"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("hi\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["hi"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("Ctrl+Z 把刚清空的草稿放回来", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\x1a"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(screenText(output).includes("Input restored"));

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["abc"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("清空后又打了字，Ctrl+Z 不覆盖新内容", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("hi"));
			input.emit("data", Buffer.from("\x1a"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["hi"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});
});

describe("Ctrl+C 清空输入框", () => {
	it("有草稿时只清空，不进入退出确认", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("abc"));
			pressCtrlC(input);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(screenText(output).includes("Input cleared · Ctrl+Z to undo"));

			// 仍在这个界面里：继续输入能正常提交
			input.emit("data", Buffer.from("hi\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["hi"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("清空后 Ctrl+Z 取回原文", async (t) => {
		const { input, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("abc"));
			pressCtrlC(input);
			input.emit("data", Buffer.from("\x1a"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["abc"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});
});

describe("折叠粘贴", () => {
	const text = "l1\nl2\nl3\nl4\nl5";

	it("多行粘贴折成标记，回车把原文发给模型", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from(`\x1b[200~${text}\x1b[201~`));
			await new Promise<void>((resolve) => setImmediate(resolve));

			const screen = screenText(output);
			assert.ok(screen.includes("[Pasted #1: 5 lines]"));
			// 正文不进输入框：否则每帧都要重排整段粘贴
			assert.equal(screen.includes("l5"), false);

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, [text]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("紧贴标记再贴同一段内容就展开，发送的仍是原文", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from(`\x1b[200~${text}\x1b[201~`));
			input.emit("data", Buffer.from(`\x1b[200~${text}\x1b[201~`));
			await new Promise<void>((resolve) => setImmediate(resolve));

			const screen = screenText(output);
			assert.equal(screen.includes("[Pasted #"), false);
			assert.ok(screen.includes("l5"));

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, [text]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});

	it("短粘贴不折叠，按原样进输入框", async (t) => {
		const { input, output, agent, running } = startTui(t);
		try {
			input.emit("data", Buffer.from("\x1b[200~x\ny\x1b[201~"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(screenText(output).includes("[Pasted #"), false);
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(agent.prompts, ["x\ny"]);
		} finally {
			exitTui(input);
		}
		assert.equal(await running, 0);
	});
});
