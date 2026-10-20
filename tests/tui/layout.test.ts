import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { AgentEvent, AgentEventListener } from "../../src/agent/events.ts";
import { ApprovalBroker } from "../../src/permission/approval.ts";
import type { ApprovalAnswer } from "../../src/permission/policy.ts";
import { runTui, type AgentRuntime } from "../../src/tui/layout.ts";
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

const ENTER = "\x1b[?1049h\x1b[5 q\x1b[?25l\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[?2004h";
const CLEAR = "\x1b[H\x1b[2J";
const LEAVE = "\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1004l\x1b[0 q\x1b[?25h\x1b[?1049l";
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

/** 内容行都定位到第 1 列；滚动条列的重画跟在所有内容行之后，不属于某一行。 */
const ROW_START = /\x1b\[\d+;1H/;
const COLUMN_HOME = /\x1b\[\d+;\d+H/;

function frameLines(output: FakeOutput): string[] {
	const frame = lastFrame(output);
	const body = frame.slice(frame.indexOf(CLEAR) + CLEAR.length);
	const rows = body.split(ROW_START).slice(1);
	const last = rows.pop() ?? "";
	return [...rows, last.split(COLUMN_HOME)[0] ?? ""];
}

function cursorAt(output: FakeOutput, row: number, column: number): boolean {
	return rawFrame(output).endsWith(`\x1b[${row};${column}H\x1b[?25h`);
}

function plain(line: string): string {
	return line
		.replace(/\x1b\[[0-9;]*m/g, "")
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

	it("模型面板支持鼠标点击选择", async () => {
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
			// 面板从主区域底部开始：第 13 行是第一项，第 14 行是第二项
			input.emit("data", Buffer.from("\x1b[<0;10;14M"));
			assert.equal(selected, "openai/gpt-5.2");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全面板支持鼠标点击执行", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/"));
			// 面板第一项是 /model，第四项是 /help
			input.emit("data", Buffer.from("\x1b[<0;10;15M"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — help"));
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
			assert.ok(text.includes("! Warning:"));
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("/effort"));
			assert.ok(text.includes("/compact"));
			assert.ok(text.includes("Requires a valid configuration"));
			assert.ok(lines.some((line) => line.includes("› /")));
			assert.ok(lines.some((line) => line.endsWith(" 4 ────")));
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
			assert.equal(text.includes("Waiting for response..."), false);
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
			assert.ok(text.includes("Bash: npm test"));
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
			assert.ok(text.includes("[a] always:"));
			assert.ok(text.includes('"git status"'));
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

	it("重试时状态行说明第几次", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "retrying", attempt: 2, reason: "connection reset" });

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Retrying (2)..."));
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
			assert.ok(after.includes("Waiting for response..."));
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
			assert.ok(frame.includes("› Bash  npm test (10ms)"));
			assert.equal(frame.includes("cd /work"), false);

			doubleClick(rowOf("› Bash"));
			frame = text();
			assert.ok(frame.includes("cd /work && npm test 2>&1 | tail -5"));

			doubleClick(rowOf("◆ Bash"));
			frame = text();
			assert.equal(frame.includes("cd /work"), false);
			assert.ok(frame.includes("› Bash  npm test (10ms)"));
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

			agent.emit({ type: "tool_end", callId: "c1", name: "read", isError: false, durationMs: 12, summary: "" });
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read  a.ts"));
			assert.equal(text.includes('{"path"'), false);
			assert.equal(text.includes("done"), false);

			agent.emit({ type: "tool_start", callId: "c2", name: "bash", args: { command: "false" } });
			agent.emit({ type: "tool_end", callId: "c2", name: "bash", isError: true, durationMs: 3, summary: "exit 1" });
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("× Bash  exit 1 (3ms)"));
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
			agent.emit({ type: "tool_end", callId: "c1", name: "read", isError: false, durationMs: 1, summary: "" });
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

	it("中止状态不带冻结的转圈符号", (t) => {
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

			const status = frameLines(output).find((line) => plain(line).includes("Aborted"));
			assert.ok(status);
			assert.ok(status.includes(THEME.error));
			assert.ok(plain(status).trimStart().startsWith("Aborted"));
			assert.ok(
				frameLines(output).some((line) => plain(line).includes("× Error: aborted")),
			);
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

	it("键盘滚动对话流，滚上去后不自动跟随，可回底", (t) => {
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

			input.emit("data", Buffer.from("\x1b[1;5F"));
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
			assert.equal(lines.join("\n").includes("Waiting for response..."), false);
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
			input.emit("data", Buffer.from("/"));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("/reload"));
			assert.ok(text.includes("Reload external plugins"));

			input.emit("data", Buffer.from("reload now\r"));
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
