import { EventEmitter } from "node:events";

import type { AgentEvent, AgentEventListener } from "#src/agent/events.ts";
import type { AgentRuntime } from "#src/tui/options.ts";
import type { ImageAttachment, ImageSource } from "#src/tui/image.ts";

/**
 * 全屏界面测试的公共脚手架。
 *
 * 假终端、假对话、帧解析与配色常量集中在这里：用例文件只关心自己的交互场景。
 */

export class FakeInput extends EventEmitter {
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

export class FakeOutput extends EventEmitter {
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
export function createFakeAgent(onRefresh: () => void = () => {}): FakeAgent {
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

export const ENTER = "\x1b[?1049h\x1b[5 q\x1b[?25l\x1b[?1004h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[>1u";
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
export const LEAVE = "\x1b[<u\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1004l\x1b[0 q\x1b[?25h\x1b[?1049l";
export const FOCUS = "\x1b[38;2;78;201;176m";
export const BLUR = "\x1b[38;2;42;49;56m";
export const INFO = "\x1b[38;2;167;176;186m";
export const BORDER = "─";
export const CURSOR_SUFFIX = /\x1b\[\d+;\d+H\x1b\[\?25h(?:\x1b\[\?2026l)?$/;
export const FOOTER_INFO = {
	project: "Reins",
	branch: "main",
	model: "gpt-5.6-luna",
	effort: "max",
	contextUsed: 100_000,
	contextWindow: 1_000_000,
	cacheHitRate: 0.98,
};
export const WARNING = "Warning: No provider openai; available: fengshao";
export const MODEL_ITEMS = [
	{
		provider: "fengshao",
		model: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		current: true,
	},
	{ provider: "openai", model: "gpt-5.2", name: "GPT-5.2", current: false },
	{ provider: "openai", model: "gpt-5.2-mini", name: "GPT-5.2 Mini", current: false },
];
export const SESSION_ITEMS = [
	{ id: "0123456789abcdef", title: "Fix the login flow", time: "2 hours ago", current: true },
	{ id: "fedcba9876543210", title: "Write the release notes", time: "3 days ago", current: false },
];
export const FORKED_SESSION_ITEMS = [
	...SESSION_ITEMS,
	{
		id: "aaaabbbbccccdddd",
		title: "Fix the login flow",
		time: "just now",
		current: false,
		forkedFrom: "Fix the login flow",
	},
];
export const IMAGE_ATTACHMENT: ImageAttachment = {
	name: "screenshot.png",
	mimeType: "image/png",
	data: "aGVsbG8=",
	bytes: 842 * 1024,
};

export function fakeImageSource(overrides: Partial<ImageSource> = {}): ImageSource {
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

export function pressCtrlC(input: FakeInput): void {
	input.emit("data", Buffer.from([3]));
}

/** 连按两次；测试失败时也要保证界面收尾。 */
export function exitTui(input: FakeInput): void {
	pressCtrlC(input);
	pressCtrlC(input);
}

export function rawFrame(output: FakeOutput): string {
	return output.chunks.at(-1) ?? "";
}

/** 去掉末尾的光标定位序列与同步输出标记，只看画面本身。 */
export function lastFrame(output: FakeOutput): string {
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

export function frameLines(output: FakeOutput): string[] {
	const frame = lastFrame(output).replace(ROW_ERASE, "");
	const rows = frame.split(ROW_START).slice(1);
	const last = rows.pop() ?? "";
	return [...rows, last.split(COLUMN_HOME)[0] ?? ""];
}

export function cursorAt(output: FakeOutput, row: number, column: number): boolean {
	return rawFrame(output).endsWith(`\x1b[${row};${column}H\x1b[?25h${SYNC_END}`);
}

export function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

