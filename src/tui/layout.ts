import { StringDecoder } from "node:string_decoder";

import { renderFooter } from "./footer.ts";
import { renderMain } from "./main.ts";

/**
 * 全屏启动。
 *
 * 进入终端的备用屏，按当前尺寸铺满整个窗口；尺寸变化时重画。页脚是一个带上下边框的输入框，
 * 输入框里一有内容，主区域的品牌名与版本号就让位隐藏。Ctrl+C 要连按两次才退出：第一次在
 * 页脚下边框里提示，第二次才恢复原屏幕。这一步只建立界面外壳，不读取配置、不启动模型。
 */

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/** Ctrl+C 在原始模式下以控制字符到达，不会触发 SIGINT，必须自己识别。 */
const CTRL_C = "\x03";
/** 第一次 Ctrl+C 之后等待第二次的时间；超过就回到未确认状态。 */
const EXIT_CONFIRM_WINDOW_MS = 2000;

/** 界面只依赖终端的这几个能力，测试因此可以交进假终端。 */
export interface TuiInput {
	readonly isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
	resume(): unknown;
	pause(): unknown;
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

export interface TuiOutput {
	readonly isTTY?: boolean;
	columns?: number;
	rows?: number;
	write(chunk: string): unknown;
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
}

export interface TuiOptions {
	readonly version: string;
	readonly stdin?: TuiInput;
	readonly stdout?: TuiOutput;
}

/**
 * 在备用屏里显示界面，直到使用者连按两次 Ctrl+C。
 *
 * 返回值就是进程退出码：正常退出为 0。终端不是 TTY 时由调用方先拦下，这里不重复判断——
 * 原始模式只在真实终端上存在。
 */
export async function runTui(options: TuiOptions): Promise<number> {
	const stdin: TuiInput = options.stdin ?? process.stdin;
	const stdout: TuiOutput = options.stdout ?? process.stdout;

	let input = "";
	let exitArmed = false;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let finish = (): void => {};
	const decoder = new StringDecoder("utf8");

	const render = (): void => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = Math.max(1, stdout.rows ?? DEFAULT_ROWS);
		const footer = renderFooter(width, input, exitArmed);
		const mainHeight = Math.max(0, height - footer.length);
		const main =
			input.length === 0
				? renderMain(width, mainHeight, options.version)
				: Array.from({ length: mainHeight }, () => "");
		// 原始模式下换行不再由终端补回车，必须显式写全，否则每一行会错位
		const lines = [...main, ...footer].slice(0, height);
		stdout.write(CURSOR_HOME + CLEAR_SCREEN + lines.join("\r\n"));
	};

	const disarm = (): void => {
		if (exitTimer !== undefined) {
			clearTimeout(exitTimer);
			exitTimer = undefined;
		}
		if (!exitArmed) return;
		exitArmed = false;
		render();
	};

	const cleanup = (): void => {
		if (finished) return;
		finished = true;

		if (exitTimer !== undefined) {
			clearTimeout(exitTimer);
			exitTimer = undefined;
		}
		stdout.off("resize", render);
		stdin.off("data", onData);
		process.off("SIGINT", onInterrupt);
		stdin.setRawMode?.(false);
		stdin.pause();
		stdout.write(SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN);
		finish();
	};

	const onCtrlC = (): void => {
		if (exitArmed) {
			cleanup();
			return;
		}
		exitArmed = true;
		render();
		exitTimer = setTimeout(disarm, EXIT_CONFIRM_WINDOW_MS);
	};

	const onData = (chunk: Buffer): void => {
		const text = decoder.write(chunk);
		if (text.includes(CTRL_C)) {
			onCtrlC();
			return;
		}

		const next = appendInput(input, text);
		if (next === input) return;
		input = next;
		render();
	};

	const onInterrupt = (): void => {
		cleanup();
	};

	const done = new Promise<number>((resolve) => {
		finish = () => resolve(0);
	});

	try {
		stdout.write(ENTER_ALTERNATE_SCREEN + HIDE_CURSOR);
		stdin.setRawMode?.(true);
		stdin.resume();
		stdout.on("resize", render);
		stdin.on("data", onData);
		process.on("SIGINT", onInterrupt);
		render();
	} catch (error) {
		cleanup();
		throw error;
	}

	return done;
}

/**
 * 把终端读到的字符并进输入框。
 *
 * 光标固定在最末，因此退格就是删掉最后一个字符；方向键等转义序列整段丢弃，不能当成文字
 * 填进去。转义序列通常在一次读取里完整到达，所以状态只需在这次调用内保持。
 */
function appendInput(current: string, chunk: string): string {
	let next = current;
	let escape: "none" | "escape" | "csi" | "ss3" = "none";

	for (const char of chunk) {
		if (escape === "escape") {
			if (char === "[") escape = "csi";
			else if (char === "O") escape = "ss3";
			else escape = "none";
			continue;
		}
		if (escape === "csi") {
			if (char >= "@" && char <= "~") escape = "none";
			continue;
		}
		if (escape === "ss3") {
			escape = "none";
			continue;
		}
		if (char === "\x1b") {
			escape = "escape";
			continue;
		}
		if (char === "\x7f" || char === "\b") {
			next = next.replace(/.$/u, "");
			continue;
		}
		if (char >= " ") next += char;
	}

	return next;
}
