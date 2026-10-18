import { renderFooter } from "./footer.ts";
import { renderMain } from "./main.ts";

/**
 * 全屏启动。
 *
 * 进入终端的备用屏，按当前尺寸铺满整个窗口；尺寸变化时重画，使用者按 Ctrl+C 时恢复原屏幕。
 * 这一步只建立界面外壳，不读取配置、不启动模型，退出后终端状态与启动前一致。
 */

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/** Ctrl+C 在原始模式下的字节，不会触发 SIGINT，必须自己识别。 */
const CTRL_C = 3;

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
 * 在备用屏里显示界面，直到使用者退出。
 *
 * 返回值就是进程退出码：正常退出为 0。终端不是 TTY 时由调用方先拦下，这里不重复判断——
 * 原始模式只在真实终端上存在。
 */
export async function runTui(options: TuiOptions): Promise<number> {
	const stdin: TuiInput = options.stdin ?? process.stdin;
	const stdout: TuiOutput = options.stdout ?? process.stdout;

	const render = (): void => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = Math.max(1, stdout.rows ?? DEFAULT_ROWS);
		const footer = renderFooter();
		const main = renderMain(width, Math.max(0, height - footer.length), options.version);
		// 原始模式下换行不再由终端补回车，必须显式写全，否则每一行会错位
		stdout.write(CURSOR_HOME + CLEAR_SCREEN + [...main, ...footer].join("\r\n"));
	};

	const onData = (chunk: Buffer): void => {
		if (chunk.includes(CTRL_C)) cleanup();
	};

	const onInterrupt = (): void => {
		cleanup();
	};

	let finished = false;
	let finish = (): void => {};

	const cleanup = (): void => {
		if (finished) return;
		finished = true;

		stdout.off("resize", render);
		stdin.off("data", onData);
		process.off("SIGINT", onInterrupt);
		stdin.setRawMode?.(false);
		stdin.pause();
		stdout.write(SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN);
		finish();
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
