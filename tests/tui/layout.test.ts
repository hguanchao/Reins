import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { AgentEvent, AgentEventListener } from "../../src/agent/events.ts";
import { ApprovalBroker } from "../../src/permission/approval.ts";
import type { ApprovalAnswer } from "../../src/permission/policy.ts";
import { runTui } from "../../src/tui/layout.ts";
import type { AgentRuntime, JobSource } from "../../src/tui/options.ts";
import type { ImageAttachment, ImageSource } from "../../src/tui/image-attachments.ts";
import type { JobEvent, JobView } from "../../src/tui/job-pages.ts";
import { THEME } from "../../src/tui/theme.ts";

class FakeInput extends EventEmitter {
	readonly isTTY = true;
	rawMode = false;
	resumed = false;

	setRawMode(mode: boolean): this {
		this.rawMode = mode;
		return this;
	}

	resume(): this {
		this.resumed = true;
		return this;
	}

	pause(): this {
		this.resumed = false;
		return this;
	}
}

class FakeOutput extends EventEmitter {
	readonly isTTY = true;
	columns = 40;
	rows = 12;
	readonly chunks: string[] = [];

	write(chunk: string): boolean {
		this.chunks.push(chunk);
		return true;
	}
}

interface FakeAgent {
	readonly runtime: AgentRuntime;
	/** 已经交给 runTurn 的提示，按发送顺序 */
	readonly prompts: string[];
	/** 每次发送携带的图片，与 prompts 一一对应 */
	readonly images: (readonly ImageAttachment[])[];
	emit(event: AgentEvent): void;
	finish(): Promise<void>;
}

/** 测试用的真实对话替身：submit 后由测试手动发事件、手动结束。 */
function createFakeAgent(onRefresh: () => void = () => {}): FakeAgent {
	let current:
		| {
				readonly listener: AgentEventListener;
				readonly resolve: () => void;
		  }
		| undefined;
	const prompts: string[] = [];
	const images: (readonly ImageAttachment[])[] = [];

	return {
		runtime: {
			runTurn: (prompt, attached, onEvent) =>
				new Promise<void>((resolve) => {
					prompts.push(prompt);
					images.push(attached);
					current = { listener: onEvent, resolve };
				}),
			refreshInfo: onRefresh,
		},
		prompts,
		images,
		emit: (event) => {
			void current?.listener(event);
		},
		finish: async () => {
			const run = current;
			current = undefined;
			run?.resolve();
			// 让 TUI 的 finally 微任务先跑完
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
	};
}

const ENTER = "\x1b[?1049h\x1b[5 q\x1b[?25l\x1b[?1004h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const LEAVE = "\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1004l\x1b[0 q\x1b[?25h\x1b[?1049l";
const FOCUS = "\x1b[38;2;78;201;176m";
const BLUR = "\x1b[38;2;42;49;56m";
const INFO = "\x1b[38;2;167;176;186m";
const BORDER = "─";
const CURSOR_SUFFIX = /\x1b\[\d+;\d+H\x1b\[\?25h(?:\x1b\[\?2026l)?$/;
const FOOTER_INFO = {
	project: "Reins",
	branch: "main",
	model: "gpt-5.6-luna",
	effort: "max",
	contextUsed: 100_000,
	contextWindow: 1_000_000,
	cacheHitRate: 0.98,
};
const WARNING = "Warning: No provider openai; available: fengshao";
const MODEL_ITEMS = [
	{
		provider: "fengshao",
		model: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		current: true,
	},
	{ provider: "openai", model: "gpt-5.2", name: "GPT-5.2", current: false },
	{ provider: "openai", model: "gpt-5.2-mini", name: "GPT-5.2 Mini", current: false },
];
const SESSION_ITEMS = [
	{ id: "0123456789abcdef", title: "Fix the login flow", time: "2 hours ago", current: true },
	{ id: "fedcba9876543210", title: "Write the release notes", time: "3 days ago", current: false },
];
const FORKED_SESSION_ITEMS = [
	...SESSION_ITEMS,
	{
		id: "aaaabbbbccccdddd",
		title: "Fix the login flow",
		time: "just now",
		current: false,
		forkedFrom: "Fix the login flow",
	},
];
const IMAGE_ATTACHMENT: ImageAttachment = {
	name: "screenshot.png",
	mimeType: "image/png",
	data: "aGVsbG8=",
	bytes: 842 * 1024,
};

function fakeImageSource(overrides: Partial<ImageSource> = {}): ImageSource {
	return {
		read: async (path) => ({
			...IMAGE_ATTACHMENT,
			name: path.split(/[\\/]/).at(-1) ?? "image.png",
		}),
		detect: (text) => (text === "drag.png" ? "drag.png" : undefined),
		clipboard: async () => IMAGE_ATTACHMENT,
		...overrides,
	};
}

function pressCtrlC(input: FakeInput): void {
	input.emit("data", Buffer.from([3]));
}

/** 连按两次；测试失败时也要保证界面收尾。 */
function exitTui(input: FakeInput): void {
	pressCtrlC(input);
	pressCtrlC(input);
}

function rawFrame(output: FakeOutput): string {
	return output.chunks.at(-1) ?? "";
}

/** 去掉末尾的光标定位序列与同步输出标记，只看画面本身。 */
function lastFrame(output: FakeOutput): string {
	return rawFrame(output)
		.replace(SYNC_BEGIN, "")
		.replace(SYNC_END, "")
		.replace(CURSOR_SUFFIX, "");
}

/** 内容行都定位到第 1 列；滚动条列的重画跟在所有内容行之后，不属于某一行。 */
const ROW_START = /\x1b\[\d+;1H/;
const COLUMN_HOME = /\x1b\[\d+;\d+H/;
/** 每行写入前先复位颜色并擦掉整行，解析画面时把它当作行前缀去掉。 */
const ROW_ERASE = /\x1b\[0m\x1b\[K/g;

function frameLines(output: FakeOutput): string[] {
	const frame = lastFrame(output).replace(ROW_ERASE, "");
	const rows = frame.split(ROW_START).slice(1);
	const last = rows.pop() ?? "";
	return [...rows, last.split(COLUMN_HOME)[0] ?? ""];
}

function cursorAt(output: FakeOutput, row: number, column: number): boolean {
	return rawFrame(output).endsWith(`\x1b[${row};${column}H\x1b[?25h${SYNC_END}`);
}

function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("全屏布局", () => {
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
			assert.equal(output.chunks.length, written);
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

	it("主区域在输入框之上居中", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			const lines = frameLines(output);
			assert.equal(lines.length, 12);
			assert.equal(lines[2], `${" ".repeat(17)}Reins`);
			assert.equal(lines[3], `${" ".repeat(17)}v1.2.3`);
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
			assert.ok(text.includes("Configuration required"));
			assert.equal(text.includes("Waiting for model..."), false);

			// 阻断是静止提示：不转圈、不占用活动强调色
			const status = frameLines(output).find((line) => plain(line).includes("Configuration required")) ?? "";
			assert.equal(status.includes("⠋"), false);
			assert.equal(status.includes(THEME.accent), false);
			assert.ok(status.includes(THEME.textSecondary));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

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

	it("输入命中命令时输入框里的命令着色，参数不着色", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		const inputLine = (): string => {
			const lines = frameLines(output);
			const index = lines.findIndex((line) => plain(line).startsWith(" › "));
			return index < 0 ? "" : (lines[index] ?? "");
		};

		try {
			// 没打全不算命中
			input.emit("data", Buffer.from("/mod"));
			assert.equal(inputLine().includes(`${FOCUS}/mod`), false);

			// 打全之后命令着色，后面的参数保持正文色
			input.emit("data", Buffer.from("el foo"));
			const line = inputLine();
			assert.equal(plain(line), " › /model foo");
			assert.ok(line.includes(`${FOCUS}/model${THEME.reset}`));
			assert.ok(line.endsWith(" foo"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入完整命令再按空格，直接打开对应的选择面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session "));
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.includes(" 2 ────")), "会话面板打开了");
			assert.ok(lines.some((line) => line.includes("Fix the login flow")));
			// 命令本身留在输入框里，面板只是提前展开
			assert.ok(lines.some((line) => line.trim() === "› /session"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令后面继续输入参数时面板收起", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session "));
			assert.ok(frameLines(output).map(plain).some((line) => line.includes(" 2 ────")));

			input.emit("data", Buffer.from("fedcba"));
			assert.equal(
				frameLines(output).map(plain).some((line) => line.includes(" 2 ────")),
				false,
				"开始打参数后不再显示面板",
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /model 在输入框上方打开模型面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));

			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.endsWith(" 3 ────")));
			assert.ok(lines.some((line) => line.includes("fengshao/")));
			assert.ok(lines.some((line) => line.includes("› /model")));
			// 面板只盖在输入框上方，输入行仍然可编辑，光标照常显示
			assert.equal(CURSOR_SUFFIX.test(rawFrame(output)), true);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话面板的鼠标点击即切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 40;
		output.rows = 12;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: (id) => {
					selected = id;
					return { changed: true, history: [], warnings: [] };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			// 行号从画面里取，不写死：面板位置取决于终端高度与页脚
			const rows = frameLines(output).map(plain);
			const borderRow = rows.findIndex((line) => line.includes(" 2 ────")) + 1;
			const secondRow = rows.findIndex((line) => line.includes("fedcba9876543210")) + 1;
			assert.ok(borderRow > 0 && secondRow > 0, "面板与第二项都画出来了");

			// 上边框本身不响应
			input.emit("data", Buffer.from(`\x1b[<0;10;${borderRow}M`));
			assert.equal(selected, undefined);

			// 点第二项直接切换，不需要回车
			input.emit("data", Buffer.from(`\x1b[<0;10;${secondRow}M`));
			assert.equal(selected, "fedcba9876543210", "点击即切换会话");
			assert.equal(
				frameLines(output)
					.map(plain)
					.join("\n")
					.includes("Fix the login flow"),
				false,
				"面板收掉",
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话面板里点击当前会话不重新加载", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 40;
		output.rows = 12;
		let selectCalls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => {
					selectCalls += 1;
					return { changed: true, history: [], warnings: [] };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			const rows = frameLines(output).map(plain);
			const currentRow = rows.findIndex((line) => line.includes("0123456789abcdef")) + 1;
			assert.ok(currentRow > 0);

			// 点当前会话：面板收掉，但不切换
			input.emit("data", Buffer.from(`\x1b[<0;10;${currentRow}M`));
			assert.equal(selectCalls, 0);
			assert.equal(frameLines(output).map(plain).join("\n").includes("Fix the login flow"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("模型面板点击即切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			const rows = frameLines(output).map(plain);
			const borderRow = rows.findIndex((line) => line.includes(" 3 ────")) + 1;
			const secondRow = rows.findIndex((line) => line.includes("openai/gpt-5.2")) + 1;
			assert.ok(borderRow > 0 && secondRow > 0);

			// 点上边框不响应
			input.emit("data", Buffer.from(`\x1b[<0;10;${borderRow}M`));
			assert.equal(selected, undefined);

			// 点第二项直接切换，不需要回车
			input.emit("data", Buffer.from(`\x1b[<0;10;${secondRow}M`));
			assert.equal(selected, "openai/gpt-5.2", "点击即切换模型");
			// 面板收起：画面上不再有面板上边框
			assert.equal(
				frameLines(output)
					.map(plain)
					.some((line) => line.includes(" 3 ────")),
				false,
				"面板收掉",
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Esc 关掉命令补全面板后不会自己弹回来", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		const panelOpen = (): boolean =>
			frameLines(output).map(plain).some((line) => line.includes("/help"));

		try {
			input.emit("data", Buffer.from("/"));
			assert.equal(panelOpen(), true, "输入斜杠后面板打开");

			input.emit("data", Buffer.from("\x1b"));
			assert.equal(panelOpen(), false, "Esc 关掉面板");

			// 输入没变时再按回车，不会把面板重新算出来
			input.emit("data", Buffer.from("\r"));
			assert.equal(panelOpen(), false, "输入不变时面板保持关闭");

			// 输入一变，补全重新出现
			input.emit("data", Buffer.from("h"));
			assert.equal(panelOpen(), true, "继续输入后补全回来");
		} finally {
			exitTui(input);
		}
	});

	it("只有斜杠时回车不发送也不入队", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
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

			// 一个斜杠还不是命令：关掉补全后回车，既不入队也不发出去
			input.emit("data", Buffer.from("/"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["first"]);
			assert.equal(frameLines(output).map(plain).join("\n").includes("↳ /"), false);
			assert.ok(
				frameLines(output).map(plain).some((line) => line.trim() === "› /"),
				"输入框保留那个斜杠",
			);
		} finally {
			exitTui(input);
		}
	});

	it("命令补全面板点击即执行", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/"));
			// 点 /help 那一行：命令清单会随内置命令增减而整体移动，按内容找行比写死行号稳
			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("/help")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;10;${row}M`));

			// 点击即执行：帮助页直接打开，不需要回车
			assert.ok(
				frameLines(output)
					.map(plain)
					.join("\n")
					.includes("Reins — help"),
			);
		} finally {
			exitTui(input);
		}
	});

	it("方向键移动并回车切换模型，页脚随之更新", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		// 块级空行让这段对话需要更多高度，默认 12 行会把首行正文顶到吸顶提示后面
		output.rows = 20;
		let selected: string | undefined;
		let info = FOOTER_INFO;
		const running = runTui({
			version: "1.2.3",
			info: () => info,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					info = { ...FOOTER_INFO, model: item.model };
					return { warnings: ["note"], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(selected, "openai/gpt-5.2");
			assert.ok(text.includes("Model switched to openai/gpt-5.2."));
			assert.ok(text.includes("! Warning: note"));
			assert.ok(text.includes("openai/gpt-5.2"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全同时匹配命令说明", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/configuration"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("/effort"));
		} finally {
			exitTui(input);
		}
	});

	it("Esc 关闭模型面板且不切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x1b"));

			const lines = frameLines(output).map(plain);
			assert.equal(calls, 0);
			assert.equal(lines.some((line) => line.includes("Model switched")), false);
			assert.ok(lines.some((line) => line.includes("Reins")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("模型面板按 Tab 只补全到输入框，回车才切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(selected, undefined);
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line === " › /model openai/gpt-5.2"));
			// 模型面板已经收起，没有切换记录
			assert.equal(lines.some((line) => line.includes("fengshao/")), false);

			input.emit("data", Buffer.from("\r"));
			assert.equal(selected, "openai/gpt-5.2");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("思考等级面板按 Tab 只补全到输入框，回车才写回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: (level) => {
					selected = level;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(selected, undefined);
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line === " › /effort high"));

			input.emit("data", Buffer.from("\r"));
			assert.equal(selected, "high");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/model 带未知模型时报告错误，不切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model nope\r"));

			assert.equal(calls, 0);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Unknown model: nope"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/effort 带未知等级时报告错误，不写回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: (level) => {
					selected = level;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort bogus\r"));

			assert.equal(selected, undefined);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Unknown effort: bogus"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("面板打开时打字：面板收掉，文字进输入框", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			// `/model` 不再是当前输入的内容，面板失去意义
			input.emit("data", Buffer.from("x"));

			assert.equal(calls, 0);
			const lines = frameLines(output).map(plain);
			assert.equal(lines.some((line) => line.includes("fengshao/")), false);
			assert.ok(lines.some((line) => line.includes("/modelx")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 补出普通命令名，补全面板保持打开", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/hel"));
			input.emit("data", Buffer.from("\t"));

			const lines = frameLines(output).map(plain);
			// 输入框补全成带空格的命令名
			assert.ok(lines.some((line) => line === " › /help "));
			// 补全面板没有收掉，说明行仍在画面里
			assert.ok(lines.some((line) => line.includes("Show the commands and keys")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 直接打开模型面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(calls, 0);
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.includes("fengshao/deepseek-v4.1-flash")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 直接打开思考等级面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: () => {},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort"));
			input.emit("data", Buffer.from("\t"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("xhigh"));
			assert.ok(text.includes("› medium"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/session 打开当前项目的会话菜单，Esc 返回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Fix the login flow"));
			assert.ok(text.includes("0123456789abcdef"));
			assert.ok(text.includes("Write the release notes"));
			assert.ok(text.includes("current"));

			input.emit("data", Buffer.from("\x1b"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Write the release notes"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话菜单按 Tab 只补全，回车才切换并替换对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: (id) => {
					selected = id;
					return {
						changed: true,
						history: [{ prompt: "old work", response: ["old answer"] }],
						warnings: [],
					};
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(selected, undefined);
			let lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line === " › /session fedcba9876543210"));
			assert.equal(lines.some((line) => line.includes("Write the release notes")), false);

			input.emit("data", Buffer.from("\r"));

			assert.equal(selected, "fedcba9876543210");
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("old work"));
			assert.ok(text.includes("old answer"));
			assert.ok(text.includes("Switched to session fedcba9876543210."));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/session 菜单标出分叉来源", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 100;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => FORKED_SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("↳ Fork of Fix the login flow"));
			assert.ok(text.includes("f fork at end"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/fork 从当前会话末尾分叉并显示复制量", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const forks: string[] = [];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: (id) => {
					forks.push(id);
					return {
						changed: true,
						history: [{ prompt: "old work", response: ["old answer"] }],
						warnings: [],
						fork: { sourceId: id, copied: 4 },
					};
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/fork\r"));

			assert.deepEqual(forks, ["0123456789abcdef"]);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Forked from 0123456789abcdef · 4 entries copied"));
			assert.ok(text.includes("Workspace unchanged"));
			assert.ok(text.includes("old work"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话菜单按 f 从选中的会话分叉", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const forks: string[] = [];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: (id) => {
					forks.push(id);
					return {
						changed: true,
						history: [],
						warnings: [],
						fork: { sourceId: id, copied: 2 },
					};
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			// 光标从当前会话移到下一条，再按 f
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("f"));

			assert.deepEqual(forks, ["fedcba9876543210"]);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Forked from fedcba9876543210 · 2 entries copied"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("分叉失败时报告错误，保留当前对话", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: () => {
					throw new Error("This session has no entries to fork from");
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/fork\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Failed to fork session"));
			assert.ok(text.includes("no entries to fork from"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话切换失败时报告错误，保留当前对话", async () => {		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => {
					throw new Error("Session file is broken");
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session fedcba9876543210\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Failed to switch session"));
			assert.ok(text.includes("Session file is broken"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 直接打开会话菜单", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session"));
			input.emit("data", Buffer.from("\t"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Fix the login flow"));
			assert.ok(text.includes("Write the release notes"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("面板打开时退格：面板收掉，输入删掉一个字符", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x7f"));

			assert.equal(calls, 0);
			const lines = frameLines(output).map(plain);
			assert.equal(lines.some((line) => line.includes("fengshao/")), false);
			// 补全面板里也有 `/model`，只有整行匹配输入框才能确认退格真的删掉了字符
			assert.ok(lines.some((line) => line === " › /mode"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("没有菜单时 Tab 不改动输入", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\t"));

			const lines = frameLines(output).map(plain);
			assert.ok(lines.includes(" › abc"));
			// 输入框里不该留下制表符
			assert.equal(lines.some((line) => line.includes("\t")), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("面板打开时连按两次 Ctrl+C 仍能退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			pressCtrlC(input);
			// 第一次只进入待确认状态，不该退出备用屏
			assert.equal(output.chunks.some((chunk) => chunk.includes(LEAVE)), false);
			pressCtrlC(input);
			assert.ok(output.chunks.some((chunk) => chunk.includes(LEAVE)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入斜杠立即显示命令补全，配置不可用时也显示", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		// 命令已经超过一屏：只显示前八条，默认 12 行终端会把主区域挤没，警告就看不见了
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			warning: WARNING,
			ready: false,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/"));

			const lines = frameLines(output).map(plain);
			const text = lines.join("\n");
			assert.ok(text.includes("! Warning:"));
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("/effort"));
			assert.ok(text.includes("/compact"));
			assert.ok(text.includes("Requires a valid configuration"));
			assert.ok(lines.some((line) => line.includes("› /")));
			assert.ok(lines.some((line) => line.endsWith(" 14 ────")));
			assert.ok(CURSOR_SUFFIX.test(rawFrame(output)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全随输入过滤，回车打开模型面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/m"));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("Choose the model for this session"));

			input.emit("data", Buffer.from("\r"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" 3 ────"));
			assert.ok(text.includes("fengshao/"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Esc 关闭命令补全并保留输入", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/"));
			input.emit("data", Buffer.from("\x1b"));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Choose the model for this session"), false);
			assert.ok(text.includes("› /"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("配置对不上时仍可 /model，选中后解除受限", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			warning: WARNING,
			ready: false,
			agent: agent.runtime,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\r"));

			assert.equal(selected, "fengshao/deepseek-v4.1-flash");

			input.emit("data", Buffer.from("hello\r"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Waiting for model..."));
			assert.equal(text.includes("Configuration required"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /effort 打开等级面板，回车写回并更新页脚", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let selected: string | undefined;
		let info = FOOTER_INFO;
		const running = runTui({
			version: "1.2.3",
			info: () => info,
			effortMenu: {
				current: () => "medium",
				select: (level) => {
					selected = level;
					info = { ...FOOTER_INFO, effort: level };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort\r"));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" 6 ────"));
			assert.ok(text.includes("off"));
			assert.ok(text.includes("xhigh"));
			assert.ok(text.includes("› medium"));
			assert.ok(text.includes("Everyday work with a clear scope"));
			assert.ok(text.includes("current"));

			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\r"));

			text = frameLines(output).map(plain).join("\n");
			assert.equal(selected, "high");
			assert.ok(text.includes("Effort set to high."));
			assert.ok(text.includes("🧠 high"));
			// 确认后面板关闭、输入框重新获得焦点
			assert.equal(text.includes("xhigh"), false);
			assert.ok(CURSOR_SUFFIX.test(rawFrame(output)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Esc 关闭等级面板且不写回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: () => {
					calls += 1;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort\r"));
			input.emit("data", Buffer.from("\x1b"));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(calls, 0);
			assert.equal(text.includes("Effort set to"), false);
			assert.equal(text.includes("xhigh"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

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
			assert.ok(text.includes("· compacting context (6 messages, ~5000 tokens)"));
			assert.ok(text.includes("Compacting context..."));

			void listener?.({ type: "compaction_end", covered: 6, tokensBefore: 5000, tokensAfter: 1200 });
			t.mock.timers.tick(100);
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("compacted: ~5000 → ~1200 tokens"));
			assert.ok(refreshes >= 1);

			finishCompact?.();
			await new Promise<void>((resolve) => setImmediate(resolve));
			t.mock.timers.tick(2000);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("compacted: ~5000 → ~1200 tokens"));
			assert.equal(text.includes("Done"), false);
			assert.equal(text.includes("Compacting context..."), false);
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
			assert.ok(frameLines(output).map(plain).join("\n").includes("Writing response..."));

			await agent.finish();

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("hi"));
			assert.equal(text.includes("Done"), false);
			assert.equal(text.includes("Writing response..."), false);
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
			assert.ok(text.includes("Configuration required"));
			assert.equal(text.includes("Waiting for model..."), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批面板替换输入区与页脚，结束后恢复", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);
			assert.ok(frameLines(output).map(plain).join("\n").includes("📁 Reins"));

			let decision: ApprovalAnswer | undefined;
			void broker
				.request({ tool: "bash", risk: "destructive", detail: "npm test" })
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			let lines = frameLines(output);
			let text = lines.map(plain).join("\n");
			assert.ok(text.includes("Permission required"));
			assert.ok(text.includes("Bash  npm test"));
			assert.ok(text.includes("←/→ select"));
			assert.equal(text.includes("destructive"), false);
			assert.ok(text.includes("[y] allow once"));
			assert.ok(text.includes("[n] deny"));
			// 面板占据原本页脚的六行；输入行、状态行与信息行都不再显示
			assert.ok(plain(lines[6] ?? "").includes("Permission required"));
			assert.equal(text.includes("📁 Reins"), false);

			input.emit("data", Buffer.from("y"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
			lines = frameLines(output);
			text = lines.map(plain).join("\n");
			assert.equal(text.includes("Permission required"), false);
			// 审批结束后输入区与页脚原样恢复
			assert.ok(text.includes("📁 Reins"));
			assert.equal(plain(lines[9] ?? ""), " › ");

			decision = undefined;
			void broker.request({ tool: "write", risk: "destructive", detail: "a.ts" }).then((value) => {
				decision = value;
			});
			t.mock.timers.tick(100);
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批卡显示时对话流仍可双击展开和滚动", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});
		const plainLines = (): string[] => frameLines(output).map(plain);
		const rowOf = (needle: string): number =>
			plainLines().findIndex((line) => line.includes(needle)) + 1;

		try {
			input.emit("data", Buffer.from("hello\r"));
			const body = Array.from({ length: 30 }, (_, index) => `line${String(index + 1).padStart(2, "0")}`);
			agent.emit({ type: "reasoning_delta", text: body.join("\n") });
			t.mock.timers.tick(100);

			void broker.request({ tool: "bash", risk: "destructive", detail: "npm test" });
			t.mock.timers.tick(100);
			assert.ok(plainLines().join("\n").includes("Permission required"));

			// 双击审批卡上方的思考标题：对话流照常展开，审批卡不消失
			let headerRow = rowOf("Thinking…");
			assert.ok(headerRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			let text = plainLines().join("\n");
			assert.ok(text.includes("line01"));
			assert.ok(text.includes("Permission required"));

			// PageDown/PageUp 滚动对话流
			input.emit("data", Buffer.from("\x1b[6~"));
			text = plainLines().join("\n");
			assert.equal(text.includes("line01"), false);
			assert.ok(text.includes("Permission required"));

			input.emit("data", Buffer.from("\x1b[5~"));
			text = plainLines().join("\n");
			assert.ok(text.includes("line01"));

			// 滚轮同样可以滚动
			input.emit("data", Buffer.from(`${"\x1b[<65;10;10M".repeat(5)}`));
			text = plainLines().join("\n");
			assert.equal(text.includes("line01"), false);
			input.emit("data", Buffer.from(`${"\x1b[<64;10;10M".repeat(5)}`));
			text = plainLines().join("\n");
			assert.ok(text.includes("line01"));

			// 再双击收起，审批卡仍在
			headerRow = rowOf("Thinking…");
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			text = plainLines().join("\n");
			assert.equal(text.includes("line01"), false);
			assert.ok(text.includes("Permission required"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批动作支持鼠标点击", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let decision: string | undefined;
			void broker
				.request({ tool: "bash", risk: "destructive", detail: "npm test" })
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			// 面板占底部六行；动作行是主区域之后的第 5 行，点 [y]
			input.emit("data", Buffer.from("\x1b[<0;5;19M"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批出现后直接回车确认", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);
			let decision: string | undefined;
			void broker
				.request({ tool: "bash", risk: "destructive", detail: "npm test" })
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批面板按 a 记住本会话范围", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let answer: string | undefined;
			void broker
				.request({
					tool: "bash",
					risk: "destructive",
					detail: "git status",
					saveLabel: 'commands starting with "git status"',
					saveShort: "git status",
				})
				.then((value) => {
					answer = value;
				});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes('[a] always for "git status"'));
			assert.ok(text.includes("[n] deny"));

			input.emit("data", Buffer.from("a"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(answer, "always");
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Permission required"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("方向键选择审批动作，回车确认", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let decision: string | undefined;
			void broker
				.request({
					tool: "bash",
					risk: "destructive",
					detail: "git status",
					saveLabel: 'commands starting with "git status"',
					saveShort: "git status",
				})
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			// 默认高亮 once；右键移到 always，回车确认
			input.emit("data", Buffer.from("\x1b[C"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "always");

			decision = undefined;
			void broker
				.request({
					tool: "bash",
					risk: "destructive",
					detail: "git push",
					saveLabel: 'commands starting with "git push"',
					saveShort: "git push",
				})
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			// 新请求回到默认的 once，直接回车确认
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Ctrl+E 展开最近思考区块", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "reasoning_delta", text: "line1\nline2\nline3\nline4\nline5\nline6" });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);

			input.emit("data", Buffer.from("\x05"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("line1"));

			input.emit("data", Buffer.from("\x05"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);
		} finally {
			exitTui(input);
		}
	});

	it("Ctrl+O 展开最近成功工具结果", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "RESULT-BODY",
				content: "RESULT-BODY",
			});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("RESULT-BODY"), false);

			input.emit("data", Buffer.from("\x0f"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("RESULT-BODY"));

			input.emit("data", Buffer.from("\x0f"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("RESULT-BODY"), false);
		} finally {
			exitTui(input);
		}
	});

	it("Ctrl+O 可展开收起工具组里的结果", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "A-BODY",
				content: "A-BODY",
			});
			agent.emit({ type: "tool_start", callId: "c2", name: "read", args: { path: "b.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c2",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "B-BODY",
				content: "B-BODY",
			});
			t.mock.timers.tick(100);
			await agent.finish();

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("B-BODY"), false);

			input.emit("data", Buffer.from("\x0f"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("B-BODY"));
		} finally {
			exitTui(input);
		}
	});

	it("命令没被截短时，双击仍能展开它的输出", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("跑一下\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "bash",
				args: { command: "python bubble_sort.py" },
			});
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 264,
				summary: "SORTED-OUTPUT",
				content: "SORTED-OUTPUT",
			});
			t.mock.timers.tick(100);

			// 结果默认不展开：这一行折叠时只显示命令与耗时
			assert.equal(frameLines(output).map(plain).join("\n").includes("SORTED-OUTPUT"), false);

			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("Bash")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			const expanded = frameLines(output).map(plain).join("\n");
			assert.ok(expanded.includes("SORTED-OUTPUT"));
			// 行首换成展开标记，不再写着「折叠着」
			assert.ok(expanded.includes("◆ Bash"));

			// 再双击一次收起
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			assert.equal(frameLines(output).map(plain).join("\n").includes("SORTED-OUTPUT"), false);
		} finally {
			exitTui(input);
		}
	});

	it("双击展开的工具组成员，显示该成员的完整参数", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("看看两个文件\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "src/a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "A-BODY",
				content: "A-BODY",
				details: { startLine: 1, endLine: 1, totalLines: 1 },
			});
			agent.emit({ type: "tool_start", callId: "c2", name: "read", args: { path: "src/b.ts" } });
			t.mock.timers.tick(100);

			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("› Read  a.ts")) + 1;
			assert.ok(row > 0);

			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("A-BODY"));
			assert.equal(text.includes("path:"), false);
		} finally {
			exitTui(input);
		}
	});

	it("运行中的 Thinking 标题显示耗时", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("你好\r"));
			agent.emit({ type: "reasoning_delta", text: "thinking" });
			t.mock.timers.tick(1500);

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Thinking… 1.0s"));
		} finally {
			exitTui(input);
		}
	});

	it("双击展开长思考时保持标题位置，不跳到底部", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const plainLines = (): string[] => frameLines(output).map(plain);
		const rowOf = (needle: string): number =>
			plainLines().findIndex((line) => line.includes(needle)) + 1;

		try {
			input.emit("data", Buffer.from("你好\r"));
			const body = Array.from({ length: 20 }, (_, index) => `line${String(index + 1).padStart(2, "0")}`);
			agent.emit({ type: "reasoning_delta", text: body.join("\n") });
			t.mock.timers.tick(100);

			const headerRow = rowOf("Thinking…");
			assert.ok(headerRow > 0);

			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));

			const text = plainLines().join("\n");
			// 展开后标题仍在视口里，并且从头显示正文，而不是跳到最后一行的位置
			assert.ok(text.includes("Thinking…"));
			assert.ok(text.includes("line01"));
		} finally {
			exitTui(input);
		}
	});

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
			assert.equal(main.includes("Reins"), false);
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
			assert.equal(lines[0], `${" ".repeat(7)}Reins`);
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

	it("输入框一有输入，品牌名与版本号就隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("a"));

			const typed = frameLines(output);
			const main = typed.slice(0, 6).join("\n");
			assert.equal(main.includes("Reins"), false);
			assert.equal(main.includes("v1.2.3"), false);
			assert.equal(plain(typed[9] ?? ""), " › a");
			assert.ok(cursorAt(output, 10, 5));
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
			assert.ok(status.startsWith(" ⠋ Waiting for model...  0.0s"));
			assert.ok(status.endsWith("0.0s  ⇣0"));
			assert.equal(status.length, 58);
			assert.ok((lines[7] ?? "").includes("\x1b[38;2;"));
			assert.equal(plain(lines[9] ?? ""), " › ");
			assert.ok(cursorAt(output, 10, 4));
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
			assert.ok(status.includes("Waiting for model..."));
			assert.ok(status.includes("0.3s"));
			assert.ok(status.endsWith("0.3s  ⇣0"));

			agent.emit({ type: "reasoning_delta", text: "thinking" });
			t.mock.timers.tick(100);
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Thinking..."));
			assert.ok(status.includes("0.1s"));
			assert.ok(status.endsWith("0.4s  ⇣0"));

			agent.emit({ type: "text_delta", text: "hello from the model" });
			t.mock.timers.tick(100);
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Writing response..."));
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
			assert.ok(text.includes("Retrying (2/5): connection reset..."));
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
			assert.ok(after.includes("Waiting for model..."));
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

	it("每行按自己的坐标写，滚动条列在内容之后单独重画", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 40;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
			});
			t.mock.timers.tick(100);

			const frame = lastFrame(output);
			// 不再靠换行符顺推：一行的实际列宽由终端决定，顺推会让后面的行整体错位
			assert.equal(frame.includes("\r\n"), false);

			const rows = [...frame.matchAll(/\x1b\[(\d+);1H/g)].map((match) => Number(match[1]));
			assert.deepEqual(rows, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

			// 内容行写完之后，主区域的每一行都按自己的行号重画了一次最右列
			const gutter = [...frame.matchAll(/\x1b\[(\d+);40H/g)].map((match) => Number(match[1]));
			assert.deepEqual(gutter, [1, 2, 3, 4, 5, 6]);

			// 这一列里滑块是一整段，没有被内容带偏而断开
			const column = gutter.map((row) => {
				const at = frame.indexOf(`\x1b[${row};40H`);
				return plain(frame.slice(at)).charAt(`\x1b[${row};40H`.length);
			});
			const first = column.indexOf("█");
			assert.ok(first > 0);
			assert.equal(column.slice(first).join("").includes(" "), false);
			assert.equal(column.slice(0, first).includes("█"), false);
		} finally {
			exitTui(input);
		}
	});

	it("思考正文运行时显示最后五行，双击标题展开或收起", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const rowOf = (needle: string): number =>
			frameLines(output).findIndex((line) => plain(line).includes(needle)) + 1;
		const doubleClick = (row: number): void => {
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
		};

		try {
			input.emit("data", Buffer.from("你好\r"));
			agent.emit({ type: "reasoning_delta", text: "line1\nline2\nline3\n" });
			agent.emit({ type: "reasoning_delta", text: "line4\nline5\nline6\nline7" });
			t.mock.timers.tick(500);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("✻ Thinking…"));
			assert.ok(
				["line3", "line4", "line5", "line6", "line7"].every((line) => text.includes(line)),
			);
			assert.equal(text.includes("line1"), false);
			assert.equal(text.includes("line2"), false);

			// 双击 Thinking… 展开全文
			doubleClick(rowOf("Thinking…"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("line1"));
			assert.ok(text.includes("line2"));

			// 再次双击回到最后五行
			doubleClick(rowOf("Thinking…"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);
			assert.ok(text.includes("line3"));

			// 结束：默认收起为标题
			agent.emit({ type: "text_delta", text: "你好，我能读写文件和跑命令。" });
			t.mock.timers.tick(100);
			const finished = frameLines(output);
			text = finished.map(plain).join("\n");
			assert.ok(text.includes("✻ Thought for 0.5s"));
			assert.equal(text.includes("line3"), false);
			assert.ok(
				finished.some(
					(line) => line.includes(THEME.textSubtle) && plain(line).includes("Thought for 0.5s"),
				),
			);

			// 双击 Thought for Xs 展开全文
			doubleClick(rowOf("Thought for 0.5s"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("line1"));
			assert.ok(text.includes("line5"));

			// 再次双击收起
			doubleClick(rowOf("Thought for 0.5s"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);
			assert.ok(text.includes("Thought for 0.5s"));

			// 回答仍在摘要之后
			assert.ok(text.indexOf("Thought for 0.5s") < text.indexOf("你好，我能读写文件和跑命令。"));
		} finally {
			exitTui(input);
		}
	});

	it("bash 行只显示核心命令，双击展开完整命令", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			workspaceRoot: "/work",
		});

		const text = (): string => frameLines(output).map(plain).join("\n");
		const rowOf = (needle: string): number =>
			frameLines(output).findIndex((line) => plain(line).includes(needle)) + 1;
		const doubleClick = (row: number): void => {
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
		};

		try {
			input.emit("data", Buffer.from("跑测试\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "bash",
				args: { command: "cd /work && npm test 2>&1 | tail -5" },
			});
			agent.emit({ type: "tool_end", callId: "c1", name: "bash", isError: false, durationMs: 10, summary: "" });
			t.mock.timers.tick(100);

			// 折叠态：多余的工作根 cd 已剥掉，只剩核心命令与耗时
			let frame = text();
			assert.ok(frame.includes("› Bash  npm test (0.0s)"));
			assert.equal(frame.includes("cd /work"), false);

			doubleClick(rowOf("› Bash"));
			frame = text();
			assert.ok(frame.includes("cd /work && npm test 2>&1 | tail -5"));

			doubleClick(rowOf("◆ Bash"));
			frame = text();
			assert.equal(frame.includes("cd /work"), false);
			assert.ok(frame.includes("› Bash  npm test (0.0s)"));
		} finally {
			exitTui(input);
		}
	});

	it("工具成功不在对话流里留 done 行，失败仍显示", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("跑一下\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read  a.ts"));
			assert.ok(text.includes("Running Read..."));

			agent.emit({ type: "tool_end", callId: "c1", name: "read", isError: false, durationMs: 12, summary: "A-BODY" });
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read  a.ts"));
			assert.equal(text.includes('{"path"'), false);
			assert.equal(text.includes("done"), false);

			agent.emit({ type: "tool_start", callId: "c2", name: "bash", args: { command: "false" } });
			agent.emit({ type: "tool_end", callId: "c2", name: "bash", isError: true, durationMs: 3, summary: "exit 1" });
			t.mock.timers.tick(100);

			let lines = frameLines(output);
			text = lines.map(plain).join("\n");
			// 失败直接落在调用行上：显示命令与耗时，不再另起一行错误摘要
			assert.ok(text.includes("× Bash  false (0.0s)"));
			assert.equal(text.includes("× Bash  exit 1"), false);

			// 双击这一行展开完整命令和详细报错
			const failedRow = lines.findIndex((line) => plain(line).includes("× Bash"));
			assert.ok(failedRow >= 0);
			const row = failedRow + 1;
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("false"));
			assert.ok(text.includes("exit 1"));
		} finally {
			exitTui(input);
		}
	});

	it("工具结束后把结构化结果指标挂到折叠行", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("读一下\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 12,
				summary: "content",
				content: "content",
				details: { startLine: 1, endLine: 120, totalLines: 400 },
			});
			t.mock.timers.tick(100);

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read  a.ts (1-120 of 400)"));
		} finally {
			exitTui(input);
		}
	});

	it("失败的行与状态里的 Error 用错误色", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("跑个命令\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "false" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: true,
				durationMs: 3,
				summary: "exit 1",
			});
			agent.emit({ type: "error", message: "boom" });
			t.mock.timers.tick(100);

			const lines = frameLines(output);
			const failed = lines.find((line) => plain(line).includes("× Bash"));
			const error = lines.find((line) => plain(line).includes("× Error: boom"));
			const status = lines.find((line) => plain(line).includes("Error"));

			assert.ok(failed?.includes(THEME.error));
			assert.ok(error?.includes(THEME.error));
			assert.ok(status?.includes(THEME.error));
			// 已经不是「正在进行」了：状态行不该还用强调色，也不必扫光
			assert.equal(status?.includes(THEME.accent), false);
		} finally {
			exitTui(input);
		}
	});

	it("连续只读工具运行时展开，回合结束折叠", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hi\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({ type: "tool_end", callId: "c1", name: "read", isError: false, durationMs: 1, summary: "A-BODY" });
			agent.emit({ type: "tool_start", callId: "c2", name: "read", args: { path: "b.ts" } });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◈ Read 2 files"));
			assert.ok(text.includes("› Read  a.ts"));
			assert.ok(text.includes("› Read  b.ts"));

			await agent.finish();

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read 2 files"));
			assert.equal(text.includes("› Read  a.ts"), false);
			assert.equal(text.includes("› Read  b.ts"), false);

			// 双击组头展开，不必等下一轮
			const headerRow = frameLines(output).map(plain).findIndex((line) => line.includes("› Read 2 files")) + 1;
			assert.ok(headerRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◈ Read 2 files"));
			assert.ok(text.includes("› Read  a.ts"));
		} finally {
			exitTui(input);
		}
	});

	it("中止后清空状态行，只在对话流留下说明", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "aborted" });
			t.mock.timers.tick(100);

			const frame = frameLines(output);
			const text = frame.map(plain).join("\n");
			// 主动停下由对话流说明，状态行不再保留 Stopped 结局，也不再转圈
			assert.equal(text.includes("Stopped"), false);
			assert.equal(text.includes("Stopping..."), false);
			assert.equal(text.includes("⠋"), false);

			// 对话流里留一条弱化色的说明，标出回答在这里被截断
			const note = frame.find((line) => plain(line).includes("Interrupted"));
			assert.ok(note);
			assert.ok(note.includes(THEME.textSubtle));
			assert.equal(plain(note).includes("Error"), false);
			assert.equal(frame.some((line) => plain(line).includes("×")), false);
		} finally {
			exitTui(input);
		}
	});

	it("状态行区分写工具调用、等待子代理与等待模型", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));

			agent.emit({ type: "writing_tool_call", name: "read" });
			let status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Writing tool call..."));

			agent.emit({ type: "tool_start", callId: "s1", name: "subagent", args: { task: "检查一" } });
			agent.emit({ type: "tool_start", callId: "s2", name: "subagent", args: { task: "检查二" } });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for subagent..."));

			// 子代理内部的进度更新不能把状态改写成普通工具在跑
			agent.emit({ type: "tool_update", callId: "s1", text: "step 2/8" });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for subagent..."));

			// 并行派发时先结束一个，另一个还在跑，状态仍是等待子代理
			agent.emit({ type: "tool_end", callId: "s1", name: "subagent", isError: false, durationMs: 10, summary: "ok" });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for subagent..."));

			agent.emit({ type: "tool_end", callId: "s2", name: "subagent", isError: false, durationMs: 10, summary: "ok" });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for model..."));
		} finally {
			exitTui(input);
		}
	});

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
			assert.ok(status.includes("Writing response..."));
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
			assert.equal(lines.join("\n").includes("Waiting for model..."), false);
		} finally {
			exitTui(input);
		}
	});

	it("还没输入就按退格，品牌名与版本号仍然显示", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			const written = output.chunks.length;
			input.emit("data", Buffer.from([0x7f]));

			assert.equal(output.chunks.length, written);
			const lines = frameLines(output);
			const main = lines.slice(0, 6).join("\n");
			assert.ok(main.includes("Reins"));
			assert.ok(main.includes("v1.2.3"));
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

	it("退格清空输入后品牌名与版本号仍然隐藏", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from([0x7f]));

			const lines = frameLines(output);
			assert.equal(plain(lines[9] ?? ""), " › ab");
			assert.equal(lines.slice(0, 6).join("\n").includes("Reins"), false);
			assert.ok(cursorAt(output, 10, 6));

			input.emit("data", Buffer.from([0x7f]));
			input.emit("data", Buffer.from([0x7f]));
			const cleared = frameLines(output);
			assert.equal(cleared.slice(0, 6).join("\n").includes("Reins"), false);
			assert.equal(cleared.slice(0, 6).join("\n").includes("v1.2.3"), false);
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

	it("插件命令出现在补全里并能执行，参数原样传入", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let call: { name: string; args: string } | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			pluginCommands: {
				list: () => [{ name: "reload", description: "Reload external plugins", enabled: true }],
				run: async (name, args) => {
					call = { name, args };
					return ["External plugins reloaded"];
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			// 内置命令已经占满一屏，先过滤出插件命令再看补全
			input.emit("data", Buffer.from("/reload"));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("/reload"));
			assert.ok(text.includes("Reload external plugins"));

			input.emit("data", Buffer.from(" now\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			text = frameLines(output).map(plain).join("\n");
			assert.deepEqual(call, { name: "reload", args: "now" });
			assert.ok(text.includes("› /reload"));
			assert.ok(text.includes("External plugins reloaded"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全面板列出 /help", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/"));

			const panel = frameLines(output).map(plain).join("\n");
			assert.ok(panel.includes("/help"));
			assert.ok(panel.includes("Show the commands and keys"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /help 打开整屏帮助页，Esc 返回，期间按键不进输入框", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/help\r"));

			const help = frameLines(output).map(plain);
			const text = help.join("\n");
			assert.equal(help[0], "Reins — help");
			assert.ok(text.includes("Commands"));
			assert.ok(text.includes("/model"));
			// 帮助页顶掉启动画面，并且不再画光标
			assert.equal(text.includes("v1.2.3"), false);
			assert.equal(CURSOR_SUFFIX.test(rawFrame(output)), false);

			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b"));

			const back = frameLines(output).map(plain);
			assert.ok(back.join("\n").includes("v1.2.3"));
			assert.equal(back.join("\n").includes("Reins — help"), false);
			assert.equal(back[9], " › ");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("整屏页打开时第一次 Ctrl+C 返回对话流，2 秒内再按退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/help\r"));
			assert.equal(frameLines(output).map(plain)[0], "Reins — help");

			pressCtrlC(input);
			const back = frameLines(output).map(plain);
			assert.ok(back.join("\n").includes("v1.2.3"));
			assert.equal(back.join("\n").includes("Reins — help"), false);
			// 第一次只返回对话流，不退出备用屏
			assert.equal(output.chunks.some((chunk) => chunk.includes(LEAVE)), false);

			// 退出确认窗口内的第二次按退出
			pressCtrlC(input);
			assert.ok(output.chunks.some((chunk) => chunk.includes(LEAVE)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /skills 与 /mcps 打开对应的整屏页，Esc 返回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			skills: {
				list: () => [
					{
						name: "writer",
						description: "把改动整理成文档",
						note: "/home/me/.reins/skills/writer/SKILL.md",
						scope: "user",
					},
				],
				directories: ["/home/me/.reins/skills"],
			},
			mcpServers: () => [{ name: "context7", description: "connected  2 tools: a, b" }],
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/skills\r"));
			const skills = frameLines(output).map(plain);
			assert.equal(skills[0], "Reins — skills");
			assert.ok(skills.join("\n").includes("writer"));
			assert.ok(skills.join("\n").includes("SKILL.md"));

			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("/mcps\r"));
			const mcps = frameLines(output).map(plain);
			assert.equal(mcps[0], "Reins — MCP servers");
			assert.ok(mcps.join("\n").includes("context7"));
			assert.ok(mcps.join("\n").includes("2 tools"));

			// 关掉之后回到启动画面：页面没有留下任何残影
			input.emit("data", Buffer.from("\x1b"));
			assert.ok(frameLines(output).map(plain).join("\n").includes("v1.2.3"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("沙箱限制在启动区提示，/sandbox 打开说明页", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 100;
		output.rows = 24;
		const warning =
			"Sandbox mode is workspace but this platform (win32) has no usable command isolation: " +
			"path checks still apply, and shell commands are refused.";
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sandbox: {
				info: {
					mode: "workspace",
					platform: "win32",
					confinesCommands: false,
				},
				warning,
			},
			stdin: input,
			stdout: output,
		});

		try {
			let text = frameLines(output)
				.map(plain)
				.join("\n");
			assert.ok(text.includes("no usable command isolation"));

			input.emit("data", Buffer.from("/sandbox\r"));
			const page = frameLines(output).map(plain);
			text = page.join("\n");
			assert.equal(page[0]?.trimEnd(), "Reins — sandbox");
			assert.ok(text.includes("Command isolation"));
			assert.ok(text.includes("unavailable"));
			assert.ok(text.includes("Shell commands are refused"));
			assert.ok(text.includes("Esc close"));

			input.emit("data", Buffer.from("\x1b"));
			text = frameLines(output)
				.map(plain)
				.join("\n");
			assert.equal(text.includes("Reins — sandbox"), false);
			// 平台限制不是可修复的配置问题：页面关掉后启动说明仍在
			assert.ok(text.includes("no usable command isolation"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Ctrl+V 把剪贴板图片插成正文标记，发送时随消息带上图片", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			imagesSupported: () => true,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("[image: screenshot.png]"));
			assert.equal(text.includes("[img]"), false);

			input.emit("data", Buffer.from("这个间距为什么不对\r"));
			assert.deepEqual(agent.prompts, ["[image: screenshot.png] 这个间距为什么不对"]);
			assert.equal(agent.images[0]?.[0]?.name, "screenshot.png");

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("[image: screenshot.png] 这个间距为什么不对"));
			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("图片标记可以单独发送，模型能力缺失时提示", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			imagesSupported: () => false,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("does not declare image input"));

			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["[image: screenshot.png]"]);
			assert.equal(agent.images[0]?.[0]?.name, "screenshot.png");
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("[image: screenshot.png]"));

			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("删掉正文里的图片标记后，这张图不再发送", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const marker = `[image: ${IMAGE_ATTACHMENT.name}] `;
			input.emit("data", Buffer.from("\x7f".repeat(marker.length)));
			input.emit("data", Buffer.from("hi\r"));

			assert.deepEqual(agent.prompts, ["hi"]);
			assert.equal(agent.images[0]?.length, 0);

			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("读图期间回车不会发出缺少图片的半轮消息", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		let release!: (image: ImageAttachment) => void;
		const pending = new Promise<ImageAttachment>((resolve) => {
			release = resolve;
		});
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource({ clipboard: () => pending }),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, []);
			assert.ok(frameLines(output).map(plain).join("\n").includes("Still reading an image"));

			release(IMAGE_ATTACHMENT);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));

			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["[image: screenshot.png]"]);
			assert.equal(agent.images[0]?.length, 1);
			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("拖入图片路径插入正文标记，不把路径留在输入框", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			images: fakeImageSource(),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("drag.png"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			const lines = frameLines(output).map(plain);
			const text = lines.join("\n");
			assert.ok(text.includes("[image: drag.png]"));
			assert.equal(text.includes("[img]"), false);
			// 路径本身没有作为文字留在输入框里
			assert.equal(lines.some((line) => line === " › drag.png"), false);
		} finally {
			exitTui(input);
		}
	});

	it("@ 打开文件补全，Tab 插入相对路径", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			files: { list: () => ["src/tui/layout.ts", "src/tui/text.ts", "README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看一下 @src/tu"));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("src/tui/layout.ts"));
			assert.ok(text.includes("src/tui/text.ts"));
			assert.equal(text.includes("README.md"), false);

			// 文件名更短的 text.ts 排在前面，Tab 选中它并补全整段 @片段
			input.emit("data", Buffer.from("\t"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("看一下 @src/tui/text.ts"));
			assert.equal(text.includes("src/tui/layout.ts"), false);
			assert.equal(agent.prompts.length, 0);
		} finally {
			exitTui(input);
		}
	});

	it("@ 面板里回车只插入路径，不发送", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			files: { list: () => ["src/tui/layout.ts"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看看 @lay"));
			input.emit("data", Buffer.from("\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("看看 @src/tui/layout.ts"));
			assert.equal(agent.prompts.length, 0);
		} finally {
			exitTui(input);
		}
	});

	it("@ 选中图片时插入正文标记，不把路径留在提示词里", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			files: { list: () => ["shots/screen.png", "src/a.ts"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看看 @scr"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			const lines = frameLines(output).map(plain);
			const text = lines.join("\n");
			assert.ok(text.includes("[image: screen.png]"));
			assert.equal(text.includes("[img]"), false);
			assert.equal(text.includes("@scr"), false);

			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["看看 [image: screen.png]"]);
			assert.equal(agent.images[0]?.[0]?.name, "screen.png");
			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("@ 每次重新打开都重扫文件，Esc 后输入变化才再弹", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		let scans = 0;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			files: {
				list: () => {
					scans += 1;
					return ["README.md"];
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("@"));
			assert.equal(scans, 1);
			assert.ok(frameLines(output).map(plain).join("\n").includes("README.md"));

			input.emit("data", Buffer.from("\x1b"));
			assert.equal(
				frameLines(output).map(plain).join("\n").includes("README.md"),
				false,
			);

			// Esc 之后同一段输入不弹；继续输入才重新打开并重扫
			input.emit("data", Buffer.from("r"));
			assert.equal(scans, 2);
			assert.ok(frameLines(output).map(plain).join("\n").includes("README.md"));

			// 结束当前片段后重新输入 @，又扫一次
			input.emit("data", Buffer.from(" "));
			input.emit("data", Buffer.from("@"));
			assert.equal(scans, 3);
		} finally {
			exitTui(input);
		}
	});

	it("邮箱里的 @ 不弹文件补全", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			files: { list: () => ["README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("name@example.com"));
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("README.md"), false);
		} finally {
			exitTui(input);
		}
	});

	it("斜杠命令参数里的 @ 不弹文件补全", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			files: { list: () => ["README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan @rea"));
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("README.md"), false);
		} finally {
			exitTui(input);
		}
	});

	it("/skills 每次打开都重扫，改完技能重新打开就能看到", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let entries = [{ name: "writer", description: "旧说明", scope: "user" as const }];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			skills: { list: () => entries, directories: ["/skills"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/skills\r"));
			assert.ok(frameLines(output).map(plain).join("\n").includes("旧说明"));

			input.emit("data", Buffer.from("\x1b"));
			entries = [{ name: "writer", description: "新说明", scope: "user" as const }];
			input.emit("data", Buffer.from("/skills\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("新说明"));
			assert.equal(text.includes("旧说明"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("帮助页用方向键与滚轮滚动，两端收敛", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/help\r"));
			const top = frameLines(output).map(plain);
			assert.equal(top[0], "Reins — help");

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
			assert.equal(frameLines(output).map(plain)[0], "Reins — help");
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
			// 首帧徽标是启动档位
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("ASK"));

			// 循环顺序与配置清单一致：ask → auto → yolo → 回到 ask
			input.emit("data", Buffer.from("\x1b[Z"));
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("AUTO"));
			input.emit("data", Buffer.from("\x1b[Z"));
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("YOLO"));
			input.emit("data", Buffer.from("\x1b[Z"));
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("ASK"));
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
			assert.ok(plain(frameLines(output)[7] ?? "").includes("Failed to switch approval"));
			// 徽标仍停在原档位
			assert.ok(plain(frameLines(output)[11] ?? "").endsWith("ASK"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("任务面板", () => {
	it("tool_start 只更新常驻面板,运行行转圈与扫光,回合结束回静态", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: {
					explanation: "开工",
					todos: [
						{ content: "写工具", status: "completed" },
						{ content: "渲染卡片", status: "in_progress" },
					],
				},
			});
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "todo",
				isError: false,
				durationMs: 1,
				summary: "Task list updated: 1 of 2 done.",
				content: "Task list updated: 1 of 2 done.",
			});

			let text = frameLines(output).map(plain).join("\n");
			// 卡片只在常驻面板出现一次;头行汇总计数,不再重复当前任务名
			assert.equal(text.split("› Tasks  1 running · 1 done").length - 1, 1);
			assert.ok(text.includes("● Task1  写工具"));
			assert.ok(text.includes("⠋ Task2  渲染卡片"));
			assert.equal(text.includes("开工"), false);

			// 运行期间:转圈与扫光落在当前任务行
			const runningRaw = frameLines(output).find((line) => plain(line).includes("Task2")) ?? "";
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(plain(runningRaw)));
			assert.ok((runningRaw.match(/\x1b\[38;2;/g) ?? []).length > 1);

			await agent.finish();

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◐ Task2  渲染卡片"));
			assert.equal(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("参数形状不对时退回普通工具行,校验错误能挂上", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "todo", args: { todos: "nope" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "todo",
				isError: true,
				durationMs: 1,
				summary: "Arguments must be an object",
				content: "Arguments must be an object, got string",
			});

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("× Todo"));
			assert.equal(text.includes("› Tasks"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("任务面板折叠", () => {
	it("超过五条默认收起:头行显示计数,双击展开全部条目,再双击收起", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: {
					todos: Array.from({ length: 6 }, (_, index) => ({
						content: `任务${index + 1}`,
						status: index === 2 ? "in_progress" : "pending",
					})),
				},
			});

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Tasks  1 running · 5 pending"));
			assert.equal(text.includes("○ Task1"), false);
			// 运行中的折叠头行带转圈任务名
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 任务3/.test(text));

			const headerRow = (): number =>
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("Tasks")) + 1;
			let row = headerRow();
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("○ Task1  任务1"));
			// 展开态的进行中行仍是转圈(回合还在运行)
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Task3  任务3/.test(text));

			// 面板变高后头行上移,重新取行号再双击
			row = headerRow();
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("○ Task1"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("同一任务跨卡片更新时耗时继承,不重置", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			// 六条任务默认收起:头行显示进行中的任务 A 与从 0 起算的耗时
			const list = (active: string, done: string) => [
				{ content: "任务A", status: active },
				{ content: "任务B", status: done },
				...Array.from({ length: 4 }, (_, index) => ({
					content: `任务${index + 3}`,
					status: "pending",
				})),
			];
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: list("in_progress", "pending") },
			});
			let header = frameLines(output)
				.map(plain)
				.findLast((line) => line.includes("Tasks")) ?? "";
			assert.ok(header.includes("任务A"));
			assert.ok(/0\.0s/.test(header), `首张卡片耗时从 0 起算:${header}`);

			// 又过 5 秒,模型更新列表但任务 A 仍在进行:计时应继承,显示 5 秒而非重置为 0
			t.mock.timers.tick(5_000);
			agent.emit({
				type: "tool_start",
				callId: "c2",
				name: "todo",
				args: { todos: list("in_progress", "pending") },
			});
			header = frameLines(output)
				.map(plain)
				.findLast((line) => line.includes("Tasks")) ?? "";
			assert.ok(/5\.0s/.test(header), `同一任务跨更新继承计时:${header}`);

			// 换了进行中任务:计时重新从 0 起算
			t.mock.timers.tick(3_000);
			agent.emit({
				type: "tool_start",
				callId: "c3",
				name: "todo",
				args: { todos: list("completed", "in_progress") },
			});
			header = frameLines(output)
				.map(plain)
				.findLast((line) => line.includes("Tasks")) ?? "";
			assert.ok(header.includes("任务B"));
			assert.ok(/0\.0s/.test(header), `换任务后计时重置:${header}`);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("子代理组集成", () => {
	it("subagent 调用归组,结束翻新成员与计数,冻结后落终态", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "s1", name: "subagent", args: { task: "梳理结构" } });
			agent.emit({ type: "tool_start", callId: "s2", name: "subagent", args: { task: "修路径" } });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Subagents  2 running"));

			agent.emit({
				type: "tool_end", callId: "s1", name: "subagent", isError: false, durationMs: 300,
				summary: "done report", content: "done report",
				details: { steps: 3, stopReason: "done", durationMs: 300 },
			});
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("1 running · 1 done"));

			// 双击组头展开清单
			const row = frameLines(output).map(plain).findIndex((line) => line.includes("Subagents")) + 1;
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Subagent1"));
			assert.ok(text.includes("●") || text.includes("Subagent2"));

			await agent.finish();
			text = frameLines(output).map(plain).join("\n");
			// 回合结束:未归报的 s2 按失败落定,组头不再有 running
			assert.ok(!text.includes("2 running"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("常驻任务面板", () => {
	it("todo 调用后面板常驻:回合结束不消失,头行回静态,翻新计数", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "completed" }, { content: "渲染卡片", status: "in_progress" }] },
			});

			let text = frameLines(output).map(plain).join("\n");
			// 卡片只在面板出现:头行唯一,条目也跟着面板走
			assert.equal(text.split("› Tasks  1 running · 1 done").length - 1, 1);
			assert.equal(text.split("● Task1  写工具").length - 1, 1);

			await agent.finish();

			// 回合结束:面板仍在(跨回合),运行行回静态,不再有转圈
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Tasks  1 running · 1 done"));
			assert.equal(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("续聊时用历史里的任务表恢复面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			history: [{ prompt: "old work", response: ["old answer"] }],
			historyTodo: {
				kind: "todo",
				items: [
					{ content: "写工具", status: "completed" },
					{ content: "补测试", status: "pending" },
				],
			},
			stdin: input,
			stdout: output,
		});

		try {
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.split("› Tasks  1 done · 1 pending").length - 1, 1);
			assert.ok(text.includes("● Task1  写工具"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("切换会话时面板换成新会话的任务表", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			historyTodo: {
				kind: "todo",
				items: [{ content: "旧任务", status: "in_progress" }],
			},
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({
					changed: true,
					history: [],
					todo: { kind: "todo", items: [{ content: "新任务", status: "pending" }] },
					warnings: [],
				}),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("○ Task1  新任务"));
			assert.equal(text.includes("旧任务"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("全部完成后从面板移出,整张卡落到对话流", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "completed" }, { content: "渲染卡片", status: "completed" }] },
			});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			// 收尾卡只在对话流出现一次,面板同时退出
			assert.equal(text.split("› Tasks  2 done").length - 1, 1);
			assert.equal(text.split("● Task1  写工具").length - 1, 1);
			assert.ok(text.includes("● Task2  渲染卡片"));

			// 新任务开始后,历史里的收尾卡仍在;面板换成新的未收尾表
			agent.emit({
				type: "tool_start",
				callId: "c2",
				name: "todo",
				args: { todos: [{ content: "下一步", status: "in_progress" }] },
			});
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.split("› Tasks  2 done").length - 1, 1);
			assert.ok(text.includes("› Tasks  1 running"));
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Task1  下一步/.test(text));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("清空未收尾的任务表后面板消失,对话流不留卡", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "in_progress" }] },
			});
			t.mock.timers.tick(100);
			assert.ok(frameLines(output).map(plain).join("\n").includes("› Tasks  1 running"));

			agent.emit({
				type: "tool_start",
				callId: "c2",
				name: "todo",
				args: { todos: [] },
			});
			t.mock.timers.tick(100);

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("› Tasks"), false);
			assert.equal(text.includes("写工具"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("常驻任务面板占位", () => {
	it("面板出现后光标仍在输入行,不落到面板最后一行", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: {
					todos: [
						{ content: "统计 src 各目录的文件数与行数", status: "in_progress" },
						{ content: "找出最大的三个文件", status: "pending" },
						{ content: "汇总报告", status: "pending" },
					],
				},
			});
			t.mock.timers.tick(100);

			const lines = frameLines(output).map(plain);
			// 24 行终端:面板 4 行(头行 + 3 条目)占 15-18 行,输入行被顶到第 22 行。
			// 输入行若只按「主区域高度 + 页脚偏移」算,会落到面板最后一条上,看起来像凭空一根竖线
			const panelLast = lines.findLastIndex((line) => line.includes("汇总报告")) + 1;
			const inputRow = lines.findIndex((line) => line.trimEnd() === " ›") + 1;
			assert.equal(panelLast, 18);
			assert.equal(inputRow, 22);
			assert.ok(cursorAt(output, inputRow, 4));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("点击面板下方的输入框仍能把焦点收回来", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "in_progress" }] },
			});
			t.mock.timers.tick(100);

			const lines = frameLines(output).map(plain);
			const inputRow = lines.findIndex((line) => line.trimEnd() === " ›") + 1;
			const panelRow = lines.findLastIndex((line) => line.includes("写工具")) + 1;

			// 点面板那一行:面板不是输入框,焦点交出去,输入框变暗
			input.emit("data", Buffer.from(`\x1b[<0;5;${panelRow}M`));
			assert.equal(rawFrame(output).includes("\x1b[?25h"), false);

			// 点回输入行:焦点恢复,光标重新出现
			input.emit("data", Buffer.from(`\x1b[<0;5;${inputRow}M`));
			assert.ok(cursorAt(output, inputRow, 4));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("Plan 模式", () => {
	it("提交计划后自动打开审批页，批准后带着完整计划实现", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		let planMode = false;
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan\r"));
			assert.equal(planMode, true);
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("PLAN"));

			input.emit("data", Buffer.from("plan it\r"));
			assert.deepEqual(agent.prompts, ["plan it"]);

			agent.emit({
				type: "tool_start",
				callId: "p1",
				name: "present_plan",
				args: { plan: "# Add Plan mode\n\n## Steps\n\n1. Add the gate." },
			});
			agent.emit({
				type: "tool_end",
				callId: "p1",
				name: "present_plan",
				isError: false,
				durationMs: 1,
				summary: "Plan submitted for review.",
			});
			await agent.finish();
			await new Promise<void>((resolve) => setImmediate(resolve));

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — plan"));
			assert.ok(text.includes("Add Plan mode"));
			assert.ok(text.includes("approve & implement"));

			input.emit("data", Buffer.from("a"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(planMode, false);
			assert.equal(agent.prompts.length, 2);
			assert.ok(agent.prompts[1]?.startsWith("Implement this plan:"));
			assert.ok(agent.prompts[1]?.includes("Add the gate."));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Implement this plan:"));
			assert.equal(text.includes("Reins — plan"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("历史计划可以重新打开，双击计划卡与 q 退出都生效", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		let planMode = false;
		const plan = {
			kind: "plan" as const,
			text: "# Saved plan\n\n## Steps\n\n1. Keep it.",
		};
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			history: [{ prompt: "old", response: [plan] }],
			historyPlan: plan,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan\r"));
			assert.equal(planMode, true);
			input.emit("data", Buffer.from("/view-plan\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — plan"));
			assert.ok(text.includes("Saved plan"));

			// Esc 只关页面，Plan 模式仍然开着
			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, true);
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Reins — plan"), false);

			// 双击计划卡重新打开
			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("◇ Plan")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — plan"));

			// q 退出 Plan 模式
			input.emit("data", Buffer.from("q"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, false);
			assert.equal(plain(frameLines(output).join("\n")).includes("Reins — plan"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Plan 模式下插件命令不执行", async () => {
		let called = false;
		let planMode = true;
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			pluginCommands: {
				list: () => [{ name: "reload", description: "Reload plugins", enabled: true }],
				run: async () => {
					called = true;
					return ["reloaded"];
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/reload\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(called, false);
			assert.ok(
				plain(frameLines(output).join("\n")).includes("Plugin commands are unavailable in Plan mode"),
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("Plan 模式交互补充", () => {
	it("要求修改时关闭页面、保持 Plan 模式并预填输入", async () => {
		let planMode = false;
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const plan = { kind: "plan" as const, text: "# Saved plan\n\n1. Keep it." };
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			history: [{ prompt: "old", response: [plan] }],
			historyPlan: plan,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/view-plan\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — plan"));

			input.emit("data", Buffer.from("r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(planMode, true);
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Reins — plan"), false);
			assert.ok(text.includes("Revise the plan:"));
			assert.ok(text.includes("PLAN"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Plan 模式隐藏旧任务表，退出后恢复", async () => {
		let planMode = false;
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			historyTodo: {
				kind: "todo",
				items: [{ content: "写工具", status: "in_progress" }],
			},
			stdin: input,
			stdout: output,
		});

		try {
			assert.ok(frameLines(output).map(plain).join("\n").includes("写工具"));

			input.emit("data", Buffer.from("/plan\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, true);
			assert.equal(frameLines(output).map(plain).join("\n").includes("写工具"), false);

			input.emit("data", Buffer.from("/plan\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, false);
			assert.ok(frameLines(output).map(plain).join("\n").includes("写工具"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("检查点与撤销集成", () => {
	function source(available = true): {
		source: import("../../src/tui/options.ts").CheckpointSource;
		readonly restored: string[];
	} {
		const entry = {
			id: "t2",
			turn: 2,
			createdAt: Date.now() - 60_000,
			kind: "turn" as const,
			label: "Turn 2",
			changes: 1,
		};
		const preview = {
			entry,
			changes: [{ path: "src/a.ts", status: "modified" as const }],
		};
		const restored: string[] = [];
		return {
			restored,
			source: {
				available: () => available,
				error: () => (available ? undefined : "Checkpoints need a Git repository"),
				list: () => (available ? [entry] : []),
				latestUndoable: async () => (available ? preview : undefined),
				preview: async () => preview,
				restore: async () => {
					restored.push(entry.id);
					return { entry, restored: 1, removed: 0, safety: { ...entry, id: "s1", kind: "safety", label: "Before undo of Turn 2" } };
				},
			},
		};
	}

	it("/checkpoints 打开列表、预览并恢复", async () => {
		const fake = source();
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/checkpoints\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — checkpoints"));
			assert.ok(text.includes("Turn 2"));

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — undo"));
			assert.ok(text.includes("M  src/a.ts"));
			assert.ok(text.includes("will be restored"));

			input.emit("data", Buffer.from("u"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(fake.restored, ["t2"]);
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› /undo"));
			assert.ok(text.includes("Undid Turn 2"));
			assert.equal(text.includes("Reins — undo"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/undo 直接预览最近变更并恢复", async () => {
		const fake = source();
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — undo"));

			input.emit("data", Buffer.from("u"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(fake.restored, ["t2"]);
			assert.ok(plain(frameLines(output).join("\n")).includes("Undid Turn 2"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("列表预览后 Esc 取消回列表", async () => {
		const fake = source();
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/checkpoints\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — undo"));

			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — checkpoints"));

			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(plain(frameLines(output).join("\n")).includes("Reins — checkpoints"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("检查点不可用时命令给出原因，不打开页面", async () => {
		const fake = source(false);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const text = plain(frameLines(output).join("\n"));
			assert.ok(text.includes("Checkpoints need a Git repository"));
			assert.equal(text.includes("Reins — undo"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});

describe("后台作业集成", () => {
	function fakeJobs(initial: readonly JobView[] = []): {
		readonly source: JobSource;
		readonly jobs: () => readonly JobView[];
		finish(id: string, status: "done" | "failed" | "killed"): void;
	} {
		let jobs = [...initial];
		const listeners = new Set<(event: JobEvent) => void>();
		const emit = (event: JobEvent): void => {
			for (const listener of listeners) listener(event);
		};
		const output = new Map<string, string>([["j1", "line one\nline two\n"]]);
		return {
			source: {
				list: () => jobs,
				output: (id) => output.get(id) ?? "",
				kill: (id) => {
					const job = jobs.find((candidate) => candidate.id === id);
					if (job === undefined || job.status !== "running") return;
					const endedAt = Date.now();
					jobs = jobs.map((candidate) =>
						candidate.id === id ? { ...candidate, status: "killed", endedAt } : candidate,
					);
					emit({ type: "finished", job: jobs.find((candidate) => candidate.id === id)! });
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				shutdown: () => undefined,
			},
			jobs: () => jobs,
			finish: (id, status) => {
				const endedAt = Date.now();
				jobs = jobs.map((job) =>
					job.id === id ? { ...job, status, endedAt, exitCode: status === "done" ? 0 : 1 } : job,
				);
				emit({ type: "finished", job: jobs.find((job) => job.id === id)! });
			},
		};
	}

	const running: JobView = {
		id: "j1",
		command: "npm run dev",
		status: "running",
		startedAt: Date.now() - 42_000,
		sessionId: "s",
	};

	it("运行中作业在页脚上方显示 Jobs bar", async () => {
		const fake = fakeJobs([running]);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const runningTui = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			jobs: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◎ Jobs"));
			assert.ok(text.includes("1 running"));
			assert.ok(text.includes("npm run dev"));
			assert.ok(text.includes("/jobs"));
		} finally {
			exitTui(input);
		}

		assert.equal(await runningTui, 0);
	});

	it("/jobs 打开列表，Enter 看输出，k 终止", async () => {
		const fake = fakeJobs([running]);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const runningTui = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			jobs: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/jobs\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — jobs"));
			assert.ok(text.includes("▸ j1"));
			assert.ok(text.includes("npm run dev"));
			assert.ok(text.includes("Enter view output"));

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — jobs · j1"));
			assert.ok(text.includes("line one"));
			assert.ok(text.includes("k kill"));

			input.emit("data", Buffer.from("k"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("killed"));

			// 从输出页回到列表，再关掉页面才能看到对话流里的完成说明
			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — jobs"));
			assert.equal(text.includes("Reins — jobs · j1"), false);

			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Job j1 killed"));
			assert.equal(text.includes("Reins — jobs"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await runningTui, 0);
	});

	it("作业完成追加说明，Jobs bar 随运行数消失", async () => {
		const fake = fakeJobs([running]);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const runningTui = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			jobs: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			fake.finish("j1", "done");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Job j1 finished"));
			assert.ok(text.includes("npm run dev"));
			assert.equal(text.includes("◎ Jobs"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await runningTui, 0);
	});
});
