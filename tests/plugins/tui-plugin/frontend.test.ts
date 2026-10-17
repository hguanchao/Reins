import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import type { Terminal, TerminalDevice, TerminalSize } from "../../../src/tui/terminal/terminal.ts";
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

describe("输入框边框", () => {
	it("上下边框各一条细线,从第一列铺满整个终端宽", async () => {
		const { lines } = await framesWith(24, 80);
		const rules = lines.filter((line) => /^─+$/.test(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")));
		// 输入框上下两条;首屏没有欢迎框,正文区直接开始
		assert.equal(rules.length, 2);
		for (const rule of rules) {
			const visible = rule.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
			assert.equal(visible.length, 80); // 80 列终端,一条线占满
			assert.equal((rule.match(/38;2;225;225;225/g) ?? []).length, 1); // 正文白,整行单段
			assert.equal((rule.match(/38;2;50;50;55/g) ?? []).length, 0); // 不再使用暗边框色
		}
	});

	it("输入行没有左右竖线,内容从第一列开始排", async () => {
		const { lines } = await framesWith(24, 80);
		const editorRow = lines.find((line) => line.includes("Build anything"));
		assert.ok(editorRow, "placeholder row exists");
		const visible = editorRow!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
		assert.ok(!visible.includes("│"), "no vertical border");
		assert.ok(visible.startsWith("❯ Build anything"), "prompt flushes left");
	});

	it("下边框不嵌模型与审批状态,屏幕上也没有头部状态条", async () => {
		const { lines } = await framesWith(24, 80);
		const rules = lines.filter((line) => /^─+$/.test(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")));
		assert.equal(rules.length, 2);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		// 头部展示整个去掉了:模型与开关不再常驻屏幕
		assert.ok(!visibleLines.some((line) => line.includes("p/m1") && line.includes("approval=ask")));
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
		// ❯ 光标在提示符(2)+输入内容(1)之后
		assert.equal(anchorMatch[2], "4");
		// 清空再退出:Ctrl+D 只在空输入时退出
		terminal.inputListener?.("\x7f");
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
		const lastFrame = frame.slice(frame.lastIndexOf("\x1b[H"));
		const visible = lastFrame
			.split("\r\n")
			.map((line) => line.replace(/^(\r|\r\x1b\[2K)+/, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const status = visible.find((line) => line.includes("Thinking"));
		assert.ok(status, "running row exists");
		assert.ok(!status!.startsWith(" "), "spinner at the first column");

		releaseRun?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.quit();
		await running;
	});
});
