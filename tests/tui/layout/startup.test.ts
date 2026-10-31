import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFakeAgent, FakeInput, FakeOutput, ENTER, SYNC_BEGIN, SYNC_END, LEAVE, FOCUS, INFO, BORDER, FOOTER_INFO, WARNING, pressCtrlC, exitTui, rawFrame, frameLines, cursorAt, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";
import { THEME } from "#src/tui/render/theme.ts";

describe("启动期加载状态", () => {
	it("MCP 握手期间状态行显示进度，落定后清掉并把失败交给警告区", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const rows = [
			{ name: "alpha", status: "connecting", detail: "" },
			{ name: "beta", status: "connecting", detail: "" },
		];
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: createFakeAgent().runtime,
			mcpStatus: () => rows,
			startupProblems: ["plugin pack: warning — something"],
			stdin: input,
			stdout: output,
		});

		try {
			const text = (): string => frameLines(output).map(plain).join("\n");
			assert.ok(text().includes("Connecting to MCP servers (0/2 ready)…"));

			// 连接落定：一个成功一个失败
			rows[0]!.status = "connected";
			rows[0]!.detail = "1 tools: a";
			rows[1]!.status = "unreachable";
			rows[1]!.detail = "connect ECONNREFUSED";
			await new Promise<void>((resolve) => setTimeout(resolve, 250));

			const settled = text();
			assert.equal(settled.includes("Connecting to MCP"), false);
			// 部分失败按警告起头,连同插件问题一起进对话流顶部
			assert.ok(settled.includes("Warning: plugin pack: warning — something"));
			assert.ok(settled.includes("MCP server beta: connect ECONNREFUSED"));
		} finally {
			exitTui(input);
		}
	});

	it("全部成功时状态行直接消失，成功结论不进对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const rows = [{ name: "alpha", status: "connecting", detail: "" }];
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: createFakeAgent().runtime,
			mcpStatus: () => rows,
			stdin: input,
			stdout: output,
		});

		try {
			assert.ok(frameLines(output).map(plain).join("\n").includes("Connecting to MCP servers (0/1 ready)…"));

			rows[0]!.status = "connected";
			rows[0]!.detail = "2 tools: a, b";
			await new Promise<void>((resolve) => setTimeout(resolve, 250));

			const settled = frameLines(output).map(plain).join("\n");
			assert.equal(settled.includes("Connecting to MCP"), false);
			assert.equal(settled.includes("Warning:"), false);
		} finally {
			exitTui(input);
		}
	});

	it("没有 MCP 与插件问题时状态行不出现", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: createFakeAgent().runtime,
			stdin: input,
			stdout: output,
		});

		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 120));
			assert.equal(frameLines(output).map(plain).join("\n").includes("Connecting to MCP"), false);
		} finally {
			exitTui(input);
		}
	});
});

describe("终端启动与收尾", () => {
	it("进入备用屏，按当前尺寸绘制，连按两次 Ctrl+C 后恢复", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			assert.equal(output.chunks[0], ENTER);
			assert.equal(input.rawMode, true);
			assert.equal(input.resumed, true);
			assert.ok(cursorAt(output, 10, 4));

			const written = output.chunks.length;
			pressCtrlC(input);
			assert.equal(input.rawMode, true);
			// 第一次按下要给出明确反馈，否则使用者会以为按键没生效
			assert.ok(output.chunks.length > written);
			assert.ok(frameLines(output).map(plain).join("\n").includes("Ctrl+C: press again to exit"));
			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
		assert.equal(input.rawMode, false);
		assert.equal(input.resumed, false);
		assert.equal(output.chunks.at(-1), LEAVE);
	});

	it("整帧写入时不清屏，逐行擦除并包在同步输出里", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			const frame = rawFrame(output);
			assert.equal(frame.includes("\x1b[2J"), false);
			assert.ok(frame.startsWith(`\x1b[?25l${SYNC_BEGIN}`));
			assert.ok(frame.endsWith(SYNC_END));
			// 每一行都先复位颜色、擦掉整行再覆盖
			assert.equal(frame.match(/\x1b\[0m\x1b\[K/g)?.length, output.rows);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("第一次 Ctrl+C 不退出，第二次才退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			pressCtrlC(input);

			assert.equal(input.rawMode, true);
			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("超过时间窗口后要重新连按两次", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			pressCtrlC(input);
			t.mock.timers.tick(2000);

			pressCtrlC(input);
			assert.equal(
				output.chunks.some((chunk) => chunk.includes(LEAVE)),
				false,
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("启动时主区域留空，输入框在下方", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			const lines = frameLines(output);
			assert.equal(lines.length, 12);
			// 启动画面没有横幅:主区域留空,第一轮对话开始后才由 transcript 接管
			for (let row = 0; row < 8; row += 1) assert.equal(plain(lines[row] ?? ""), "");
			assert.equal(plain(lines[8] ?? ""), BORDER.repeat(40));
			assert.equal(plain(lines[9] ?? ""), " › ");
			assert.equal(plain(lines[10] ?? ""), BORDER.repeat(40));
			assert.ok(plain(lines[11] ?? "").includes("📊 100K / 1M"));
			assert.ok(lines[8]?.startsWith(FOCUS));
			assert.ok(lines[9]?.startsWith(FOCUS));
			assert.ok(lines[11]?.startsWith(INFO));
			assert.ok(cursorAt(output, 10, 4));
		} finally {
			exitTui(input);
		}
	});

	it("配置错误时仍进入界面，警告走对话流", async () => {
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
			const lines = frameLines(output);
			const text = lines.join("\n");
			assert.ok(text.includes("! Warning:"));
			assert.ok(text.includes("No provider"));
			assert.ok(plain(lines[0] ?? "").startsWith("  ! Warning:"));
			assert.equal(lines.filter((line) => line.includes("Warning:")).length, 1);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("配置错误时输入不切走警告，提交只提示配置不可用", async () => {
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
			input.emit("data", Buffer.from("hello"));

			let text = frameLines(output).join("\n");
			assert.ok(text.includes("! Warning:"));
			assert.ok(text.includes("hello"));

			input.emit("data", Buffer.from("\r"));

			text = plain(frameLines(output).join("\n"));
			assert.ok(text.includes("Configuration is invalid"));
			assert.equal(text.includes("Waiting for model…"), false);

			// 阻断是静止提示：不转圈、不占用活动强调色
			const status = frameLines(output).find((line) => plain(line).includes("Configuration is invalid")) ?? "";
			assert.equal(status.includes("⠋"), false);
			assert.equal(status.includes(THEME.accent), false);
			assert.ok(status.includes(THEME.textSecondary));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
