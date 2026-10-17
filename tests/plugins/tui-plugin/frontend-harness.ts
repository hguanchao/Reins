import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEventListener } from "../../../src/agent/events.ts";
import type { TurnDriver } from "../../../src/agent/driver.ts";
import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import type { ClipboardPort } from "../../../src/tui/clipboard.ts";
import type { InteractiveRuntime } from "../../../src/tui/frontend.ts";
import type { Terminal, TerminalDevice, TerminalSize } from "../../../src/tui/terminal/terminal.ts";

/**
 * 前端集成测试的公共脚手架：哑终端、哑运行时、帧解析与剪贴板替身。
 *
 * 交互路径要穿过整个 TerminalFrontend 才有意义，所以各功能测试都从完整的界面跑起，这里
 * 只提供它们共享的部件。
 */

/** 哑终端:记住输出,collect 输入监听者,尺寸固定。测试里手动喂按键。 */
export class MemoryTerminal implements Terminal {
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

/** 取最后一帧的可见文本行:去掉清行序列与样式序列。 */
export function lastFrameRows(output: string): string[] {
	return output
		.slice(output.lastIndexOf("\x1b[H"))
		.split("\r\n")
		.map((line) => line.replace(/^(\r|\r\x1b\[2K)+/, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
}

export async function framesWith(rows: number, cols: number): Promise<{ lines: string[] }> {
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

export function runtimeOf(): InteractiveRuntime {
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
export function osc52Clipboard(terminal: MemoryTerminal): ClipboardPort {
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
export function textClipboard(terminal: MemoryTerminal, text: string): ClipboardPort {
	return {
		...osc52Clipboard(terminal),
		readText() {
			return text;
		},
	};
}

const tempDirs: string[] = [];

/** 删掉测试期间建的工作区目录；每个测试文件在自己的 afterEach 里调用。 */
export function cleanupTempDirs(): void {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}

/** 一个可被 @ 搜索的工作区。 */
export function workspaceFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "reins-frontend-files-"));
	tempDirs.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "my dir"), { recursive: true });
	writeFileSync(join(root, "src", "app.ts"), "app");
	writeFileSync(join(root, "src", "util.ts"), "util");
	writeFileSync(join(root, "my dir", "note.txt"), "note");
	writeFileSync(join(root, "README.md"), "readme");
	return root;
}

/** 等文件索引完成或某个界面状态出现；最多等半秒。 */
export async function waitForRows(
	terminal: MemoryTerminal,
	predicate: (rows: string[]) => boolean,
): Promise<string[]> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		const rows = lastFrameRows(terminal.output);
		if (predicate(rows)) return rows;
	}
	return lastFrameRows(terminal.output);
}
