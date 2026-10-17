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
	it("上边框铺满整行宽,没有左右竖线", async () => {
		const { lines } = await framesWith(24, 80);
		const topBorder = lines.find((line) => line.includes("━"));
		assert.ok(topBorder, "drew a solid rule");
		const visible = topBorder!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
		// 整行由 PAD(2) + 实线(body=78)组成,合计 80 列铺满
		assert.ok(visible.startsWith("  "));
		assert.equal(visible.replace(/ /g, "").length, 78);
		assert.ok(!visible.includes("╭"));
	});

	it("输入行没有左右竖线,提示符直接顶在缩进后", async () => {
		const { lines } = await framesWith(24, 80);
		const editorRow = lines.find((line) => line.includes("Build anything"));
		assert.ok(editorRow, "placeholder row exists");
		const visible = editorRow!.replace(/[\x1b]\[[0-9;]*[A-Za-z]/g, "");
		assert.ok(!visible.includes("│"), "no vertical border");
		assert.match(visible, /❯ Build anything/);
	});

	it("下边框嵌着模型与审批状态,同样铺满整行", async () => {
		const { lines } = await framesWith(24, 80);
		const bottom = lines.find((line) => line.includes("p/m1") || line.includes("approval="));
		assert.ok(bottom, "bottom rule exists");
		const visible = bottom!.replace(/[\x1b]\[[0-9;]*[A-Za-z]/g, "");
		assert.ok(!visible.includes("╯"));
		assert.match(visible, /p\/m1/);
		assert.match(visible, /approval=ask/);
		assert.match(visible, /sandbox=off/);
		// 右端收在同列:实线一直铺到行尾
		assert.ok(visible.trimEnd().length <= 80);
	});
});
