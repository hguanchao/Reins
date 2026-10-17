import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import type { Terminal, TerminalDevice, TerminalSize } from "../../../src/tui/terminal/terminal.ts";
import type { ClipboardPort } from "../../../src/tui/clipboard.ts";
import type { InteractiveRuntime } from "../../../src/tui/frontend.ts";
import type { AgentEventListener } from "../../../src/agent/events.ts";
import type { TurnDriver } from "../../../src/agent/driver.ts";

/** 哑终端:记住输出,collect 输入监听者,尺寸固定。测试里手动喂按键。 */
class MemoryTerminal implements Terminal {
	output = "";
	inputListener: ((chunk: string) => void) | undefined;
	sizeValue: TerminalSize = { rows: 24, cols: 80 };

	get device(): TerminalDevice {
		return this;
	}

	size(): TerminalSize {
		return this.sizeValue;
	}

	write(text: string): void {
		this.output += text;
	}

	onInput(listener: (chunk: string) => void): void {
		this.inputListener = listener;
	}

	onResize(_listener: () => void): void {
		void _listener;
	}

	setRawMode(_enabled: boolean): void {
		void _enabled;
	}

	setCursorVisible(_visible: boolean): void {
		void _visible;
	}

	setBracketedPaste(_enabled: boolean): void {
		void _enabled;
	}

	setFocusReporting(_enabled: boolean): void {
		void _enabled;
	}

	setMouseTracking(_enabled: boolean): void {
		void _enabled;
	}

	setAlternateScreen(_enabled: boolean): void {
		void _enabled;
	}

	/** 把指定时刻画的一帧展开成可读行:按最后一次锚点切,清掉行首擦除序列。 */
	frameAt(output: string): string[] {
		const frameStart = output.lastIndexOf("\x1b[H");
		return output
			.slice(frameStart + 3)
			.split("\r\n")
			.map((line) => line.replace(/^(\r|\r\x1b\[2K)+/, ""));
	}

	quit(): void {
		this.inputListener?.("\x04"); // Ctrl+D
	}
}

function runtimeOf(): InteractiveRuntime {
	return {
		cwd: "E:\\w",
		session: { id: "s1", path: null, entries: 0 },
		provider: "p",
		model: "m1",
		approval: "ask",
		sandbox: "off",
		notify: "auto",
		trust: { trusted: false, root: "E:\\w", files: [] },
		commands: [],
		runCommand: async () => [],
		createDriver: (_onEvent: AgentEventListener) => ({}) as TurnDriver,
		sessionUsage: () => ({
			requests: 0,
			compactions: 0,
			subagents: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: undefined,
			unpriced: 0,
		}),
		setConfirmer: () => undefined,
		setNotify: () => undefined,
		setTrusted: () => undefined,
	};
}

/** 把复制内容写成 OSC 52，供界面测试断言；不碰真实剪贴板。 */
function osc52Clipboard(terminal: MemoryTerminal): ClipboardPort {
	return {
		copy(text: string) {
			terminal.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
			return { delivery: "confirmed", message: "Copied!" };
		},
		readText() {
			return undefined;
		},
	};
}

/** 固定读取内容的剪贴板；copy 仍写 OSC 52，便于断言。 */
function textClipboard(terminal: MemoryTerminal, text: string): ClipboardPort {
	return {
		...osc52Clipboard(terminal),
		readText() {
			return text;
		},
	};
}

async function framesWith(rows: number, cols: number): Promise<{ lines: string[] }> {
	const terminal = new MemoryTerminal();
	terminal.sizeValue = { rows, cols };
	const frontend = new TerminalFrontend({ terminal, env: {} });
	const running = frontend.run(runtimeOf());
	await new Promise((resolve) => setTimeout(resolve, 0)); // 让首帧画完
	// 退出前的帧才是运行中的画面:退出会清屏并写接续命令
	const snapshot = terminal.output;
	terminal.quit();
	await running;
	return { lines: terminal.frameAt(snapshot) };
}

/** 取最后一帧的可见文本行:去掉清行序列与样式序列。 */
function lastFrameRows(output: string): string[] {
	return output
		.slice(output.lastIndexOf("\x1b[H"))
		.split("\r\n")
		.map((line) => line.replace(/^(\r|\r\x1b\[2K)+/, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
}

describe("输入框边框", () => {
	it("输入框是完整方框：上边框与嵌了信息的下边框", async () => {
		const { lines } = await framesWith(24, 80);
		const visible = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const top = visible.find((line) => line.startsWith("╭") && line.endsWith("╮"));
		const bottom = visible.find((line) => line.startsWith("╰") && line.endsWith("╯"));

		assert.ok(top, "top border");
		assert.ok(bottom, "bottom border");
		assert.equal(top!.length, 80);
		assert.equal(bottom!.length, 80);
		assert.ok(top!.includes("─"));
		assert.ok(bottom!.includes("m1"), "model in the bottom border");
		assert.ok(bottom!.includes("approval=ask"), "approval mode in the bottom border");
		assert.ok(lines.some((line) => line.includes("╭") && line.includes("38;2;80;80;88")), "focused border color");
	});

	it("输入行左右有竖线，提示符在边框和内边距之后", async () => {
		const { lines } = await framesWith(24, 80);
		const editorRow = lines.find((line) => line.includes("❯"));
		assert.ok(editorRow, "editor row exists");
		const visible = editorRow!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
		assert.ok(visible.startsWith("│"), "left border");
		assert.ok(visible.endsWith("│"), "right border");
		assert.equal(visible.indexOf("❯"), 3, "border plus two padding columns");
	});

	it("模型与审批方式嵌在下边框，顶部没有单独状态条", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const bottom = visibleLines.find((line) => line.startsWith("╰") && line.endsWith("╯"));

		assert.ok(bottom);
		assert.ok(bottom!.includes("m1"));
		assert.ok(bottom!.includes("approval=ask"));
		// 第一行是会话区，不是单独的头部状态条
		assert.ok(!visibleLines[0].includes("p/m1"));
	});

	it("没有首屏欢迎:标题、提示语、菜单、Ready 一概不出现", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		assert.ok(!visibleLines.some((line) => line.includes("Reins")), "no title");
		assert.ok(!visibleLines.some((line) => line.includes("Type a message")), "no hint line");
		assert.ok(!visibleLines.some((line) => line.includes("Commands")), "no menu");
		assert.ok(!visibleLines.some((line) => line.includes("Ready")), "no top bar");
	});

	it("输入时光标列落在提示符之后:屏幕列 = 提示符 + 输入位置", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 输入一个字母,再看最后一帧里的光标绝对定位
		terminal.inputListener?.("a");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const frame = terminal.output;
		const lastFrame = frame.slice(frame.lastIndexOf("\x1b[H"));
		const anchorMatch = /(?:\x1b\[)(\d+);(\d+)H(?!.*\x1b\[\d+;\d+H)/.exec(lastFrame);
		assert.ok(anchorMatch, "cursor positioned");
		// 边框(1)+内边距(2)+提示符(2)+输入内容(1)，从 1 开始计数
		assert.equal(anchorMatch[2], "7");
		// 清空再退出:Ctrl+D 只在空输入时退出
		terminal.inputListener?.("\x7f");
		terminal.quit();
		await running;
	});

	it("输入框支持 Ctrl+J 换行", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("a\nb");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const editorRows = lastFrameRows(terminal.output).filter(
			(line) => line.startsWith("│") && line.endsWith("│"),
		);
		assert.equal(editorRows.length, 2, "editor grows to two rows");
		assert.ok(editorRows[0].includes("❯ a"));
		assert.ok(editorRows[1].includes("b"));

		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ a")), "multiline message committed");
		assert.ok(rows.some((line) => line.includes("  b")), "second line kept");

		terminal.quit();
		await running;
	});

	it("反斜杠续行先换行，补齐后再发送", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("abc\\");
		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		assert.equal(
			rows.filter((line) => line.startsWith("│") && line.endsWith("│")).length,
			2,
			"continuation keeps two editor rows",
		);
		assert.ok(rows.some((line) => line.includes("❯ abc")));
		assert.ok(!rows.some((line) => line.includes("  abc")), "nothing committed yet");

		terminal.inputListener?.("def\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ abc")), "first line committed");
		assert.ok(rows.some((line) => line.includes("  def")), "continuation line committed");

		terminal.quit();
		await running;
	});

	it("底部快捷键条从第一列开始", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const hint = visibleLines.find((line) => line.includes("Enter:send"));
		assert.ok(hint, "key hint row exists");
		assert.ok(hint!.startsWith("Enter:send"), "no left padding");
	});

	it("运行状态行从第一列开始", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		let releaseRun: (() => void) | undefined;
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) => ({
				run: async () => {
					onEvent({ type: "turn_start" });
					await new Promise<void>((resolve) => {
						releaseRun = resolve;
					});
				},
			}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const frame = terminal.output;
		const visible = lastFrameRows(frame);
		const status = visible.find((line) => line.includes("Thinking"));
		assert.ok(status, "running row exists");
		assert.ok(!status!.startsWith(" "), "spinner at the first column");

		releaseRun?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.quit();
		await running;
	});

	it("运行中按 Esc 中止这一轮", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		let aborted = false;
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) => ({
				run: async (_prompt: string, signal: AbortSignal) => {
					onEvent({ type: "turn_start" });
					await new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								aborted = true;
								resolve();
							},
							{ once: true },
						);
					});
				},
			}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 单独的 ESC 要等一小会儿，确认它不是某个转义序列的开头
		terminal.inputListener?.("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(aborted, true, "turn aborted by Esc");

		terminal.quit();
		await running;
	});

	it("空闲时按 Esc 清空输入，界面继续运行", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("abc");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("abc")), "text entered");

		terminal.inputListener?.("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const cleared = lastFrameRows(terminal.output);
		assert.ok(!cleared.some((line) => line.includes("abc")), "input cleared");
		const editor = cleared.find((line) => line.startsWith("│") && line.includes("❯"));
		assert.ok(editor, "prompt is empty");

		// Esc 不退出:还能继续输入
		terminal.inputListener?.("z");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("z")), "still running");

		terminal.inputListener?.("\x03"); // Ctrl+C 清空输入
		terminal.quit();
		await running;
	});

	it("输入斜杠显示命令下拉，方向键选择后 Tab 补全", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		for (const name of ["/help", "/exit", "/notify", "/trust"]) {
			assert.ok(rows.some((line) => line.includes(name)), `dropdown lists ${name}`);
		}
		assert.ok(rows.some((line) => line.includes("Show this help")), "description column");

		// 选中项默认是第一项 help；下移到 exit
		terminal.inputListener?.("\x1b[B");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /exit")), "Tab accepts the selected command");
		assert.ok(!rows.some((line) => line.includes("Show this help")), "dropdown closes after completion");

		terminal.inputListener?.("\x03"); // 清空
		terminal.quit();
		await running;
	});

	it("斜杠查询过滤候选；未完整输入时 Enter 只补全", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/he");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("/help")));
		assert.ok(!rows.some((line) => line.includes("/exit")), "non-matching commands are filtered out");

		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /help")), "partial command is completed, not executed");
		assert.ok(!rows.some((line) => line.includes("Interface commands")), "command did not run yet");

		// 已经完整打出命令：再按 Enter 执行
		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(
			rows.some((line) => line.includes("While browsing, Home/End")),
			"exact command executes",
		);

		terminal.quit();
		await running;
	});

	it("Esc 只收起斜杠下拉，不清空输入；鼠标单击选中、双击接受", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/he");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 50));
		let rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /he")), "Esc keeps the draft");
		assert.ok(!rows.some((line) => line.includes("Show this help")), "Esc closes the dropdown");

		// 回到空输入，重新打开下拉后用鼠标选 exit
		terminal.inputListener?.("\x03");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("/");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		const exitRow = rows.findIndex((line) => line.includes("/exit"));
		assert.ok(exitRow >= 0, "exit row is visible");
		const exitCol = rows[exitRow].indexOf("/exit") + 1;
		for (let click = 0; click < 2; click += 1) {
			terminal.inputListener?.(`\x1b[<0;${exitCol};${exitRow + 1}M`);
			terminal.inputListener?.(`\x1b[<0;${exitCol};${exitRow + 1}m`);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /exit")), "double-click accepts the row");
		assert.ok(!rows.some((line) => line.includes("Show this help")), "dropdown closes after mouse accept");

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("用户消息块按条目布局排列并带 ❯ 前缀", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hi\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const message = lastFrameRows(terminal.output).find((line) => line.startsWith("     ❯ hi"));
		assert.ok(message, "message starts after the block chrome");
		assert.equal(message!.length, 80, "band spans the full entry width plus gutter");

		terminal.quit();
		await running;
	});

	it("内容超过一屏时显示滚动条，点轨道可以跳到顶部", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			runCommand: async () => Array.from({ length: 40 }, (_, index) => `line ${index}`),
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/long\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		let rows = lastFrameRows(terminal.output).slice(0, 19);
		assert.ok(rows.some((line) => line.endsWith("█")), "thumb shown");
		assert.ok(rows.some((line) => line.endsWith("│")), "track shown");

		// 最右一列是滚动条：点顶端轨道，滑块回到顶部
		terminal.inputListener?.("\x1b[<0;80;1M");
		terminal.inputListener?.("\x1b[<0;80;1m");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output).slice(0, 19);
		assert.ok(rows[0].endsWith("█"), "thumb moved to top");

		terminal.quit();
		await running;
	});

	it("鼠标拖选后释放，文本经 OSC 52 写入剪贴板", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: osc52Clipboard(terminal) });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		// 用户消息在第二行（❯ hello）：正文从第 5 列开始，从 h 拖到第二个 l
		terminal.inputListener?.("\x1b[<0;8;2M");
		terminal.inputListener?.("\x1b[<32;11;2M");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(terminal.output.includes("\x1b[7;") || terminal.output.includes("\x1b[7m"), "selection is highlighted");

		terminal.inputListener?.("\x1b[<0;11;2m");
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.ok(terminal.output.includes("\x1b]52;c;aGVsbA=="), "copied selected text");
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("Copied! (4 chars, 1 line)")));

		terminal.quit();
		await running;
	});

	it("Ctrl+V 把多行剪贴板折成 chip，提交时展开完整内容", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = "one\ntwo\nthree\nfour";
		let received = "";
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () =>
				({
					run: async (prompt: string) => {
						received = prompt;
					},
				}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("[Pasted: 4 lines]")), "multi-line paste becomes a chip");
		assert.ok(!rows.some((line) => line.includes("one")), "chip hides the pasted body");

		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(received, content, "submit expands the chip");

		terminal.quit();
		await running;
	});

	it("Ctrl+Shift+V 内联粘贴，不生成 chip", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({
			terminal,
			env: {},
			clipboard: textClipboard(terminal, "one\ntwo\nthree\nfour"),
		});
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x1b[86;6u");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("one")), "inline paste shows the text");
		assert.ok(!rows.some((line) => line.includes("[Pasted:")), "no chip in inline mode");

		terminal.inputListener?.("\x03"); // 清空输入
		terminal.quit();
		await running;
	});

	it("再次粘贴同一段内容会把 chip 展开", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = "one\ntwo\nthree\nfour";
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("[Pasted: 4 lines]")));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(!rows.some((line) => line.includes("[Pasted:")), "chip is expanded");
		assert.ok(rows.some((line) => line.includes("one")) && rows.some((line) => line.includes("four")));

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("输入内容超过高度上限时内部滚动，整帧仍不超过终端高度", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x1b[86;6u"); // 内联粘贴
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.equal(rows.length, 24, "frame stays within the terminal height");
		assert.ok(rows.some((line) => line.includes("line 40")), "cursor end stays visible");
		assert.ok(!rows.some((line) => line.trim() === "line 1"), "top of the draft scrolls out");

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("双击粘贴 chip 直接展开", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = "one\ntwo\nthree\nfour";
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		const chipRow = rows.findIndex((line) => line.includes("[Pasted: 4 lines]"));
		assert.ok(chipRow >= 0, "chip is visible");
		const chipCol = rows[chipRow].indexOf("[Pasted: 4 lines]") + 1;

		for (let click = 0; click < 2; click += 1) {
			terminal.inputListener?.(`\x1b[<0;${chipCol};${chipRow + 1}M`);
			terminal.inputListener?.(`\x1b[<0;${chipCol};${chipRow + 1}m`);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		const expanded = lastFrameRows(terminal.output);
		assert.ok(!expanded.some((line) => line.includes("[Pasted:")), "double-click expands the chip");
		assert.ok(expanded.some((line) => line.includes("one")) && expanded.some((line) => line.includes("four")));

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("单击选中块，双击折叠/展开，主区可用键盘折叠", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) => ({
				run: async () => {
					onEvent({ type: "turn_start" });
					onEvent({ type: "tool_start", callId: "t1", name: "Read", args: { path: "a.ts" } });
					onEvent({ type: "tool_update", callId: "t1", text: "line one\nline two" });
					onEvent({
						type: "tool_end",
						callId: "t1",
						name: "Read",
						isError: false,
						durationMs: 10,
						summary: "ok",
					});
					onEvent({ type: "run_end" });
				},
			}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: osc52Clipboard(terminal) });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("run\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const toolRow = lastFrameRows(terminal.output).findIndex((line) => line.includes("◈ Read 1 file"));
		assert.ok(toolRow >= 0, "tool group header is visible");
		const clickRow = toolRow + 1; // 鼠标坐标从 1 开始

		// 单击：选中块并画选中框
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const selected = lastFrameRows(terminal.output);
		assert.ok(selected.some((line) => line.trimStart().startsWith("┌")), "selection box top");
		assert.ok(selected.some((line) => line.trimStart().startsWith("└")), "selection box bottom");
		assert.ok(!selected.some((line) => line.includes("line one")), "tool group collapsed");

		// 300ms 内第二次按下：展开组，成员先以一行摘要出现
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const expanded = lastFrameRows(terminal.output);
		assert.ok(expanded.some((line) => line.includes("◆ Read a.ts")), "group expands to member rows");
		assert.ok(!expanded.some((line) => line.includes("line one")), "member stays collapsed");

		// 双击成员：展开这个工具的完整输出
		const memberRow = lastFrameRows(terminal.output).findIndex((line) => line.includes("◆ Read a.ts"));
		assert.ok(memberRow >= 0, "member row exists");
		const memberClickRow = memberRow + 1;
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}m`);
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(
			lastFrameRows(terminal.output).some((line) => line.includes("line one")),
			"double-click expands the member",
		);

		// 焦点已在主区：e 收起成员
		terminal.inputListener?.("e");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const folded = lastFrameRows(terminal.output);
		assert.ok(!folded.some((line) => line.includes("line one")), "keyboard fold");

		// y 复制成员的完整正文（折叠状态也复制全部）
		terminal.inputListener?.("y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const copy = /(?:\x1b\]52;c;)([^\x07]*)\x07/.exec(terminal.output);
		assert.ok(copy, "clipboard sequence written");
		assert.ok(Buffer.from(copy[1], "base64").toString("utf8").includes("line one\nline two"), "y copies the member body");

		// Y 只复制元信息（工具名与参数）
		terminal.inputListener?.("Y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const sequences = [...terminal.output.matchAll(/(?:\x1b\]52;c;)([^\x07]*)\x07/g)];
		const meta = sequences.at(-1);
		assert.ok(meta, "metadata copy sequence written");
		assert.equal(Buffer.from(meta[1], "base64").toString("utf8"), "Read a.ts");

		// Tab 回输入框，继续输入
		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("x");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("❯ x")), "prompt accepts input");

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("主区焦点下 Esc 与 Ctrl+C 都能中止运行中的回合", async () => {
		for (const key of ["\x1b", "\x03"]) {
			let aborted = false;
			const terminal = new MemoryTerminal();
			terminal.sizeValue = { rows: 24, cols: 80 };
			const runtime: InteractiveRuntime = {
				...runtimeOf(),
				createDriver: (onEvent) => ({
					run: async (_prompt: string, signal: AbortSignal) => {
						onEvent({ type: "turn_start" });
						await new Promise<void>((resolve) => {
							signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									resolve();
								},
								{ once: true },
							);
						});
					},
				}) as unknown as TurnDriver,
			};
			const frontend = new TerminalFrontend({ terminal, env: {} });
			const running = frontend.run(runtime);
			await new Promise((resolve) => setTimeout(resolve, 0));

			terminal.inputListener?.("hello\r");
			await new Promise((resolve) => setTimeout(resolve, 0));
			// 点击用户消息块，把焦点切到主区
			terminal.inputListener?.("\x1b[<0;6;2M");
			terminal.inputListener?.("\x1b[<0;6;2m");
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.ok(
				lastFrameRows(terminal.output).some((line) => line.includes("j/k:entry")),
				"scrollback focused",
			);

			terminal.inputListener?.(key);
			await new Promise((resolve) => setTimeout(resolve, key === "\x1b" ? 50 : 0));
			assert.equal(aborted, true, key === "\x1b" ? "aborted by Esc" : "aborted by Ctrl+C");

			terminal.quit();
			await running;
		}
	});

	it("审批弹窗在主区焦点下显示，Esc 与 Ctrl+C 都拒绝并中止", async () => {
		for (const key of ["\x1b", "\x03"]) {
			let aborted = false;
			let confirmer: ((question: string, detail: string) => Promise<boolean>) | undefined;
			const terminal = new MemoryTerminal();
			terminal.sizeValue = { rows: 24, cols: 80 };
			const runtime: InteractiveRuntime = {
				...runtimeOf(),
				createDriver: (onEvent) => ({
					run: async (_prompt: string, signal: AbortSignal) => {
						onEvent({ type: "turn_start" });
						await new Promise<void>((resolve) => {
							signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									resolve();
								},
								{ once: true },
							);
						});
					},
				}) as unknown as TurnDriver,
				setConfirmer: (next) => {
					confirmer = next;
				},
			};
			const frontend = new TerminalFrontend({ terminal, env: {} });
			const running = frontend.run(runtime);
			await new Promise((resolve) => setTimeout(resolve, 0));

			terminal.inputListener?.("hello\r");
			await new Promise((resolve) => setTimeout(resolve, 0));
			terminal.inputListener?.("\x1b[<0;6;2M");
			terminal.inputListener?.("\x1b[<0;6;2m");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const decision = confirmer?.("Allow Bash to run?", "{}");
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.ok(
				lastFrameRows(terminal.output).some((line) => line.includes("Allow Bash to run?")),
				"dialog stays visible in scrollback focus",
			);

			terminal.inputListener?.(key);
			await new Promise((resolve) => setTimeout(resolve, key === "\x1b" ? 50 : 0));
			assert.equal(await decision, false, "dialog denied");
			assert.equal(aborted, true, "turn aborted");
			assert.ok(
				!lastFrameRows(terminal.output).some((line) => line.includes("Allow Bash to run?")),
				"dialog closed",
			);

			terminal.quit();
			await running;
		}
	});

	it("审批面板替换输入区，选项纵向排列", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		let confirmer: ((question: string, detail: string) => Promise<boolean>) | undefined;
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			setConfirmer: (next) => {
				confirmer = next;
			},
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const decision = confirmer?.("Allow Bash to run?", '{\n  "command": "npm test"\n}');
		await new Promise((resolve) => setTimeout(resolve, 0));

		const visible = lastFrameRows(terminal.output);
		assert.ok(visible.some((line) => line.includes("Allow Bash to run?")), "question is the panel title");
		assert.ok(visible.some((line) => line.includes("npm test")), "detail shown without raw JSON");
		assert.ok(!visible.some((line) => line.includes('"command"')), "no JSON in the panel");
		assert.ok(!visible.some((line) => line.includes("Approval required")), "no bordered popup title");

		assert.ok(visible.some((line) => line.includes("1 (●) Allow")), "allow option is focused");
		assert.ok(visible.some((line) => line.includes("2 (○) Deny")), "options are vertical");
		assert.ok(visible.some((line) => line.includes("↑/↓:select")), "footer shows dialog keys");

		const rules = visible.filter((line) => /^─+$/.test(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")));
		assert.equal(rules.length, 0, "input box is replaced by the permission panel");

		terminal.inputListener?.("2");
		assert.equal(await decision, false);
		terminal.quit();
		await running;
	});
});
