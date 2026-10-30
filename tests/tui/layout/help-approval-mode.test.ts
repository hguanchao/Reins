import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, FOCUS, FOOTER_INFO, MODEL_ITEMS, exitTui, frameLines, plain, rawFrame } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import { THEME } from "../../../src/tui/render/theme.ts";

describe("帮助页与审批模式", () => {
	it("帮助页用方向键与滚轮滚动，两端收敛", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/help\r"));
			const top = frameLines(output).map(plain);
			assert.equal(top[0], "Reins · help");

			// 一次下移一行
			input.emit("data", Buffer.from("\x1b[B"));
			const stepped = frameLines(output).map(plain);
			assert.equal(stepped[0], top[1]);

			// 滚轮向下同样生效
			input.emit("data", Buffer.from("\x1b[<65;20;4M"));
			const wheeled = frameLines(output).map(plain);
			assert.equal(wheeled[0], top[2]);

			// 一直滚到底，按键分区与脚注都可见
			for (let index = 0; index < 100; index += 1) input.emit("data", Buffer.from("\x1b[B"));
			const bottom = frameLines(output).map(plain).join("\n");
			assert.ok(bottom.includes("Run reins --help"));

			// 一直滚回顶部后不再上移
			for (let index = 0; index < 200; index += 1) input.emit("data", Buffer.from("\x1b[A"));
			assert.equal(frameLines(output).map(plain)[0], "Reins · help");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("帮助页内容超出视口时在右侧画出滚动条", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 10;
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/help\r"));
			const raw = rawFrame(output);
			// 滚动条单独定位在最右列，按行重画
			assert.ok(raw.includes("\x1b[1;80H"));
			assert.ok(raw.includes("█"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Shift+Tab 循环切换审批模式，页脚徽标跟着变且按键不落进输入框", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let mode: "ask" | "auto" | "yolo" = "ask";
		const selected: string[] = [];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			approvalMode: {
				current: () => mode,
				select: (next) => {
					selected.push(next);
					mode = next;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			// 输入框上下边框与输入行随审批模式换色：ask 青、auto 琥珀、yolo 红
			const inputBoxColor = (color: string): boolean =>
				[8, 9, 10].every((row) => (frameLines(output)[row] ?? "").startsWith(color));

			// 首帧徽标是启动档位
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("ASK"));
			assert.ok(inputBoxColor(FOCUS));

			// 循环顺序与配置清单一致：ask → auto → yolo → 回到 ask
			input.emit("data", Buffer.from("\x1b[Z"));
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("AUTO"));
			assert.ok(inputBoxColor(THEME.warning));
			input.emit("data", Buffer.from("\x1b[Z"));
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("YOLO"));
			assert.ok(inputBoxColor(THEME.error));
			input.emit("data", Buffer.from("\x1b[Z"));
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("ASK"));
			assert.ok(inputBoxColor(FOCUS));
			assert.deepEqual(selected, ["auto", "yolo", "ask"]);

			// 热键被吞掉，不会把序列拆成文字插进输入行
			assert.equal(plain(frameLines(output)[9] ?? ""), " › ");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("选择菜单开着时 Shift+Tab 仍然切模式，不影响补全", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let mode: "ask" | "auto" | "yolo" = "ask";
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			approvalMode: { current: () => mode, select: (next) => { mode = next; } },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			const opened = frameLines(output).map(plain).join("\n");
			assert.ok(opened.includes("openai/"));

			input.emit("data", Buffer.from("\x1b[Z"));
			assert.equal(mode, "auto");
			const frame = frameLines(output).map(plain);
			// 面板还在：Shift+Tab 不代替 Tab 补全，也不收起菜单；徽标行跟着换档
			assert.ok(frame.some((line) => line.includes("openai/")));
			assert.ok(frame.some((line) => line.includes(" › /model")));
			assert.ok(frame.some((line) => line.trimEnd().endsWith("AUTO")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("切换失败时报告原因，档位保持不动", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			approvalMode: {
				current: () => "ask",
				select: () => {
					throw new Error("policy busy");
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x1b[Z"));
			assert.ok(plain(frameLines(output)[7] ?? "").includes("approval switch failed"));
			// 徽标仍停在原档位
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("ASK"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
