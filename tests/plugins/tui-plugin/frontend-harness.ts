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
 * 前端集成测试的公共脚手架：哑终端、哑运行时、屏幕重放与剪贴板替身。
 *
 * 交互路径要穿过整个 TerminalFrontend 才有意义，所以各功能测试都从完整的界面跑起，这里
 * 只提供它们共享的部件。
 */

/** 哑终端：记住输出，收集输入监听者，尺寸固定。测试里手动喂按键。 */
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

	/** 把到指定时刻为止的输出重放成屏幕内容。 */
	frameAt(output: string): string[] {
		return replayScreen(output, this.sizeValue);
	}

	quit(): void {
		this.inputListener?.("\x04"); // Ctrl+D
	}
}

/** 取屏幕上的可见文本行。 */
export function lastFrameRows(output: string, size: TerminalSize = DEFAULT_SIZE): string[] {
	return replayScreen(output, size);
}

/** 哑终端的默认尺寸；测试里的界面断言都按它算列。 */
const DEFAULT_SIZE: TerminalSize = { rows: 24, cols: 80 };

/** 屏幕上的一格：可见字符，以及写下它时终端的状态（SGR 参数串）。 */
interface Cell {
	readonly text: string;
	readonly style: string;
}

const BLANK: Cell = { text: " ", style: "" };

function blankRow(cols: number): Cell[] {
	return Array.from({ length: cols }, () => BLANK);
}

/**
 * 把整段输出重放成屏幕上的可见文本。
 *
 * 重画是逐行差分的：没变的行一个字节都不会写出去，所以「最后一帧写了什么」并不等于「屏幕
 * 上有什么」。测试要看的是后者，这里就按终端的方式重放：光标移动、清行清屏、样式与超链接
 * 序列跳过；写满一行自动换行，越过底部整体上滚。
 *
 * 一个码点占一格，和测试里按字符数取列的习惯一致。要检查颜色时传 `styled`：每格还原成
 * 写下它时的样式序列；不传则只看文本。
 */
export function replayScreen(
	output: string,
	size: TerminalSize,
	options: { readonly styled?: boolean } = {},
): string[] {
	const screen: Cell[][] = Array.from({ length: size.rows }, () => blankRow(size.cols));
	let row = 0;
	let col = 0;
	/** 整行写满后光标停在最后一列，等下一个可打印字符才换行（终端的延迟换行）。 */
	let pending = false;
	/** 当前 SGR 参数串；空串表示终端默认样式。 */
	let sgr = "";

	const advance = (): void => {
		row += 1;
		if (row < size.rows) return;
		screen.shift();
		screen.push(blankRow(size.cols));
		row = size.rows - 1;
	};

	const clearRow = (index: number, from: number): void => {
		screen[index]?.fill(BLANK, Math.max(0, from), size.cols);
	};

	const count = (params: readonly string[], at: number, fallback: number): number => {
		const value = Number(params[at]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};

	let index = 0;
	while (index < output.length) {
		const char = output[index];
		if (char === "\x1b") {
			const kind = output[index + 1];
			if (kind === "]") {
				// OSC：超链接与剪贴板，不影响屏幕内容
				const bel = output.indexOf("\x07", index + 2);
				const st = output.indexOf("\x1b\\", index + 2);
				const ends = [bel, st].filter((end) => end >= 0);
				index = ends.length === 0 ? output.length : Math.min(...ends) + 1;
				continue;
			}
			if (kind !== "[") {
				index += 2;
				continue;
			}
			let cursor = index + 2;
			while (cursor < output.length && (output[cursor] < "@" || output[cursor] > "~")) cursor += 1;
			const params = output.slice(index + 2, cursor).split(";");
			const final = output[cursor];
			index = cursor + 1;
			pending = false;
			switch (final) {
				case "m": {
					const next = params.join(";");
					sgr = next === "" || next === "0" ? "" : next;
					break;
				}
				case "H":
				case "f":
					row = Math.min(size.rows - 1, Math.max(0, count(params, 0, 1) - 1));
					col = Math.min(size.cols - 1, Math.max(0, count(params, 1, 1) - 1));
					break;
				case "A":
					row = Math.max(0, row - count(params, 0, 1));
					break;
				case "B":
					row = Math.min(size.rows - 1, row + count(params, 0, 1));
					break;
				case "C":
					col = Math.min(size.cols - 1, col + count(params, 0, 1));
					break;
				case "D":
					col = Math.max(0, col - count(params, 0, 1));
					break;
				case "G":
					col = Math.min(size.cols - 1, Math.max(0, count(params, 0, 1) - 1));
					break;
				case "J":
					if (count(params, 0, 0) === 2) {
						for (let other = 0; other < size.rows; other += 1) clearRow(other, 0);
						break;
					}
					clearRow(row, col);
					for (let other = row + 1; other < size.rows; other += 1) clearRow(other, 0);
					break;
				case "K":
					clearRow(row, count(params, 0, 0) === 2 ? 0 : col);
					break;
				default:
					break;
			}
			continue;
		}
		if (char === "\r") {
			col = 0;
			pending = false;
			index += 1;
			continue;
		}
		if (char === "\n") {
			advance();
			pending = false;
			index += 1;
			continue;
		}
		if (char === "\b") {
			col = Math.max(0, col - 1);
			pending = false;
			index += 1;
			continue;
		}
		if (char === "\x07") {
			index += 1;
			continue;
		}

		const code = output.codePointAt(index);
		if (code === undefined) break;
		const text = String.fromCodePoint(code);
		if (pending) {
			col = 0;
			advance();
			pending = false;
		}
		screen[row][col] = { text, style: sgr };
		index += text.length;
		col += 1;
		if (col >= size.cols) {
			col = size.cols - 1;
			pending = true;
		}
	}

	return screen.map((line) => (options.styled === true ? styledText(line) : line.map((cell) => cell.text).join("")));
}

/** 把一行还原成带样式序列的文本：相邻同风格的格子合成一段。 */
function styledText(cells: readonly Cell[]): string {
	let text = "";
	let current: string | undefined;
	for (const cell of cells) {
		if (cell.style !== current) {
			if (current !== undefined && current !== "") text += "\x1b[0m";
			text += cell.style === "" ? "" : `\x1b[${cell.style}m`;
			current = cell.style;
		}
		text += cell.text;
	}
	return current === undefined || current === "" ? text : `${text}\x1b[0m`;
}

export async function framesWith(rows: number, cols: number): Promise<{ lines: string[]; styled: string[] }> {
	const terminal = new MemoryTerminal();
	terminal.sizeValue = { rows, cols };
	const frontend = new TerminalFrontend({ terminal, env: {} });
	const running = frontend.run(runtimeOf());
	await new Promise((resolve) => setTimeout(resolve, 0)); // 让首帧画完
	// 退出前的帧才是运行中的画面:退出会清屏并写接续命令
	const snapshot = terminal.output;
	terminal.quit();
	await running;
	return {
		lines: terminal.frameAt(snapshot),
		styled: replayScreen(snapshot, terminal.sizeValue, { styled: true }),
	};
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
		contextTokens: () => 12_345,
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
