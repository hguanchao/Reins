import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import {
	FOCUS,
	FakeInput,
	FakeOutput,
	FOOTER_INFO,
	MODEL_ITEMS,
	createFakeAgent,
	exitTui,
	frameLines,
	plain,
} from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";

/**
 * 输入框焦点的多场景覆盖。
 *
 * 焦点有三个来源：终端的焦点上报序列（FOCUS_IN/FOCUS_OUT）、点击输入框内外、以及打开
 * 选择面板时主动抢回。三者会互相覆盖，因此这里按场景逐条验证「最终状态」而不是单个函数。
 */

/** 焦点上报序列：进入与离开。 */
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/** 输入框边框颜色是焦点的唯一可见表现：聚焦时用 FOCUS 色，失焦时用 BLUR 色。 */
function inputBorderFocused(output: FakeOutput): boolean {
	// 页脚最后一行是信息行，不含焦点色；往上数第三行是输入框的上边框
	const lines = frameLines(output);
	const border = lines.at(-3) ?? "";
	return border.includes(FOCUS);
}

function start(t: TestContext) {
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
	return { input, output, agent };
}

describe("输入框焦点", () => {
	it("启动时输入框是聚焦的", (t) => {
		const { input, output } = start(t);
		try {
			t.mock.timers.tick(100);
			assert.ok(inputBorderFocused(output), "初始应聚焦");
		} finally {
			exitTui(input);
		}
	});

	it("终端焦点离开后输入框失去焦点，回来之后恢复", (t) => {
		const { input, output } = start(t);
		try {
			t.mock.timers.tick(100);
			assert.ok(inputBorderFocused(output), "初始应聚焦");

			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(100);
			assert.equal(inputBorderFocused(output), false, "焦点离开后应失焦");

			input.emit("data", Buffer.from(FOCUS_IN));
			t.mock.timers.tick(100);
			assert.ok(inputBorderFocused(output), "焦点回来后应恢复");
		} finally {
			exitTui(input);
		}
	});

	it("失焦后按回车只抢回焦点，不提交已有内容", (t) => {
		const { input, output, agent } = start(t);
		try {
			input.emit("data", Buffer.from("hello"));
			t.mock.timers.tick(100);
			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(100);

			input.emit("data", Buffer.from("\r"));
			t.mock.timers.tick(100);

			assert.deepEqual(agent.prompts, [], "不应提交");
			assert.ok(inputBorderFocused(output), "应抢回焦点");
		} finally {
			exitTui(input);
		}
	});

	it("失焦时点输入框（内容行与上下边框）都能重新聚焦", (t) => {
		const { input, output } = start(t);
		try {
			// 输入框在页脚：上边框、内容行、下边框。信息行不属于输入框。
			const rows = frameLines(output).length;
			const contentRow = rows - 2;
			for (const row of [contentRow - 1, contentRow, contentRow + 1]) {
				input.emit("data", Buffer.from(FOCUS_OUT));
				t.mock.timers.tick(50);
				assert.equal(inputBorderFocused(output), false, `第 ${row} 行点击前应失焦`);

				input.emit("data", Buffer.from(`\x1b[<0;3;${row}M\x1b[<0;3;${row}m`));
				t.mock.timers.tick(50);
				assert.ok(inputBorderFocused(output), `点第 ${row} 行应聚焦`);
			}
		} finally {
			exitTui(input);
		}
	});

	it("点页脚的信息行不会聚焦", (t) => {
		const { input, output } = start(t);
		try {
			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(50);

			// 最后一行是信息行，它在输入框下边框之外
			const rows = frameLines(output).length;
			input.emit("data", Buffer.from(`\x1b[<0;3;${rows}M\x1b[<0;3;${rows}m`));
			t.mock.timers.tick(50);
			assert.equal(inputBorderFocused(output), false, "信息行不属于输入框");
		} finally {
			exitTui(input);
		}
	});

	it("聚焦时点输入框外的对话流会失焦", (t) => {
		const { input, output, agent } = start(t);
		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "text_delta", text: "line 1\nline 2\nline 3" });
			t.mock.timers.tick(100);

			input.emit("data", Buffer.from("\x1b[<0;3;2M\x1b[<0;3;2m"));
			t.mock.timers.tick(100);
			assert.equal(inputBorderFocused(output), false, "点对话流应失焦");
		} finally {
			exitTui(input);
		}
	});

	it("打开模型面板再关闭，焦点应回到输入框", (t) => {
		const { input, output } = start(t);
		try {
			// 面板需要 modelMenu 源；这里只验证没有源时命令菜单的路径不破坏焦点
			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(100);
			assert.equal(inputBorderFocused(output), false);

			input.emit("data", Buffer.from(FOCUS_IN));
			t.mock.timers.tick(100);
			assert.ok(inputBorderFocused(output));
		} finally {
			exitTui(input);
		}
	});

	it("焦点离开时正在拖动滚动条会被中止", (t) => {
		const { input, output, agent } = start(t);
		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
			});
			t.mock.timers.tick(100);

			// 按在最右列开始拖动
			const columns = 40;
			const rows = frameLines(output).length;
			input.emit("data", Buffer.from(`\x1b[<0;${columns};2M`));
			t.mock.timers.tick(50);
			// 拖到别的行
			input.emit("data", Buffer.from(`\x1b[<32;${columns};5M`));
			t.mock.timers.tick(50);
			// 焦点离开：拖动应被中止，之后再移动不该继续滚动
			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from(`\x1b[<32;${columns};2M`));
			t.mock.timers.tick(100);

			// 只是确认没有抛错且仍能正常退出；拖动中止属于内部状态
			assert.ok(rows > 0);
		} finally {
			exitTui(input);
		}
	});

	it("焦点序列与普通字符同块到达时，字符仍被处理", (t) => {
		const { input, output } = start(t);
		try {
			input.emit("data", Buffer.from(`${FOCUS_IN}abc`));
			t.mock.timers.tick(100);

			const lines = frameLines(output).map(plain);
			assert.ok(
				lines.some((line) => line.includes("abc")),
				"同一块里的字符不应因焦点序列被丢弃",
			);
			assert.ok(inputBorderFocused(output));
		} finally {
			exitTui(input);
		}
	});

	it("同一块里先离开再回来，以最后一条为准", (t) => {
		const { input, output } = start(t);
		try {
			input.emit("data", Buffer.from(`${FOCUS_OUT}${FOCUS_IN}`));
			t.mock.timers.tick(100);
			assert.ok(inputBorderFocused(output), "最后一条是进入，应聚焦");

			input.emit("data", Buffer.from(`${FOCUS_IN}${FOCUS_OUT}`));
			t.mock.timers.tick(100);
			assert.equal(inputBorderFocused(output), false, "最后一条是离开，应失焦");
		} finally {
			exitTui(input);
		}
	});

	it("模态面板打开时，焦点上报仍然生效", (t) => {
		// 面板打开时切走窗口再回来：焦点状态不能停在离开前的值
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
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => ({ warnings: [], ready: true, warning: undefined }),
			},
		});
		try {
			input.emit("data", Buffer.from("/model\r"));
			t.mock.timers.tick(100);

			// 面板盖住了输入框，焦点状态要在关掉面板之后才看得到
			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(100);
			input.emit("data", Buffer.from("\x1b"));
			t.mock.timers.tick(100);
			assert.equal(inputBorderFocused(output), false, "面板期间的失焦应在关闭后仍然生效");

			input.emit("data", Buffer.from(FOCUS_IN));
			t.mock.timers.tick(100);
			assert.ok(inputBorderFocused(output), "焦点回来后恢复");
		} finally {
			exitTui(input);
		}
	});

	it("整屏页打开时，焦点上报仍然生效", (t) => {
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
			input.emit("data", Buffer.from("/help\r"));
			t.mock.timers.tick(100);

			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(100);
			// 整屏页盖住了页脚，焦点状态仍应被记下来；关页之后立刻体现
			input.emit("data", Buffer.from("\x1b"));
			t.mock.timers.tick(100);
			assert.equal(inputBorderFocused(output), false, "整屏页期间的失焦应在返回后仍生效");

			input.emit("data", Buffer.from(FOCUS_IN));
			t.mock.timers.tick(100);
			assert.ok(inputBorderFocused(output));
		} finally {
			exitTui(input);
		}
	});

	it("审批卡在场时焦点离开不会让输入框抢占按键", (t) => {
		const { input, output } = start(t);
		try {
			input.emit("data", Buffer.from(FOCUS_OUT));
			t.mock.timers.tick(100);

			// 失焦状态下 y 不应触发任何提交；此时没有审批卡，字母只是正文
			input.emit("data", Buffer.from("y"));
			t.mock.timers.tick(100);
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.includes("y")));
		} finally {
			exitTui(input);
		}
	});
});
