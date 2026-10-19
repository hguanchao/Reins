import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { AgentEvent, AgentEventListener } from "../../src/agent/events.ts";
import { ApprovalBroker } from "../../src/permission/approval.ts";
import { runTui, type AgentRuntime } from "../../src/tui/layout.ts";

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

	return {
		runtime: {
			runTurn: (_prompt, onEvent) =>
				new Promise<void>((resolve) => {
					current = { listener: onEvent, resolve };
				}),
			refreshInfo: onRefresh,
		},
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

const ENTER = "\x1b[?1049h\x1b[5 q\x1b[?25l\x1b[?1004h\x1b[?1002h\x1b[?1006h";
const CLEAR = "\x1b[H\x1b[2J";
const LEAVE = "\x1b[?1006l\x1b[?1002l\x1b[?1004l\x1b[0 q\x1b[?25h\x1b[?1049l";
const FOCUS = "\x1b[38;2;78;201;176m";
const BLUR = "\x1b[38;2;42;49;56m";
const INFO = "\x1b[38;2;167;176;186m";
const BORDER = "─";
const CURSOR_SUFFIX = /\x1b\[\d+;\d+H\x1b\[\?25h$/;
const FOOTER_INFO = {
	project: "Reins",
	branch: "main",
	model: "gpt-5.6-luna",
	effort: "max",
	contextUsed: 100_000,
	contextWindow: 1_000_000,
	cacheHitRate: 0.98,
};
const WARNING = "Config error: No provider openai; available: fengshao";
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

/** 去掉末尾的光标定位序列，只看画面本身。 */
function lastFrame(output: FakeOutput): string {
	return rawFrame(output).replace(CURSOR_SUFFIX, "");
}

function frameLines(output: FakeOutput): string[] {
	const frame = lastFrame(output);
	return frame.slice(frame.indexOf(CLEAR) + CLEAR.length).split("\r\n");
}

function cursorAt(output: FakeOutput, row: number, column: number): boolean {
	return rawFrame(output).endsWith(`\x1b[${row};${column}H\x1b[?25h`);
}

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
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
			assert.equal(plain(lines[11] ?? "").startsWith("📁 Reins"), true);
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
			assert.ok(text.includes("! Config error:"));
			assert.ok(text.includes("No provider"));
			assert.ok(plain(lines[0] ?? "").startsWith("  ! Config error:"));
			assert.equal(lines.filter((line) => line.includes("Config error")).length, 1);
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
			assert.ok(text.includes("! Config error:"));
			assert.ok(text.includes("hello"));

			input.emit("data", Buffer.from("\r"));

			text = plain(frameLines(output).join("\n"));
			assert.ok(text.includes("Configuration required"));
			assert.equal(text.includes("Waiting for response..."), false);
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
			assert.equal(CURSOR_SUFFIX.test(rawFrame(output)), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("方向键移动并回车切换模型，页脚随之更新", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
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
			assert.ok(text.includes("note"));
			assert.ok(text.includes("openai/gpt-5.2"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
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

	it("输入斜杠立即显示命令补全，配置不可用时也显示", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
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
			assert.ok(text.includes("! Config error:"));
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("/effort"));
			assert.ok(text.includes("Requires a valid configuration"));
			assert.ok(lines.some((line) => line.includes("› /")));
			assert.ok(lines.some((line) => line.endsWith(" 3 ────")));
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
			assert.ok(text.includes("Waiting for response..."));
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
			assert.ok(text.includes("›  medium"));
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

	it("工具审批在输入框上方弹出，y 放行 Enter 拒绝", async (t) => {
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

			let decision: boolean | undefined;
			void broker
				.request("Allow bash to run?", '{"command":"npm test"}')
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Allow bash to run?"));
			assert.ok(text.includes("[y/N]"));
			assert.ok(text.includes('{"command":"npm test"}'));

			input.emit("data", Buffer.from("y"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, true);
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Allow bash to run?"), false);

			decision = undefined;
			void broker.request("Allow write?", "{}").then((value) => {
				decision = value;
			});
			t.mock.timers.tick(100);
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
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
			assert.equal(plain(lines[6] ?? ""), "📁 Reins · 🌿 main");
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
			assert.ok(status.startsWith(" ⠋ Waiting for response...  0.0s"));
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
			assert.ok(status.includes("Waiting for response..."));
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

			agent.emit({ type: "usage_recorded" });
			t.mock.timers.tick(1);

			// 轮次还没结束，页脚已经是最新的一笔
			const after = frameLines(output).map(plain).join("\n");
			assert.ok(after.includes("440K / 1M"));
			assert.ok(after.includes("⚡ 75%"));
			assert.ok(after.includes("Waiting for response..."));
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

	it("命令补全面板列出 /help", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
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
			for (let index = 0; index < 40; index += 1) input.emit("data", Buffer.from("\x1b[B"));
			const bottom = frameLines(output).map(plain).join("\n");
			assert.ok(bottom.includes("Ctrl+C twice"));
			assert.ok(bottom.includes("Run reins --help"));

			// 一直滚回顶部后不再上移
			for (let index = 0; index < 60; index += 1) input.emit("data", Buffer.from("\x1b[A"));
			assert.equal(frameLines(output).map(plain)[0], "Reins — help");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
