import { StringDecoder } from "node:string_decoder";

import { FOOTER_HEIGHT, inputView, renderFooter } from "./footer.ts";
import { messageLineCount, renderMain, renderMessages } from "./main.ts";

/**
 * 全屏启动。
 *
 * 进入终端的备用屏，按当前尺寸铺满整个窗口；尺寸变化时重画。页脚是一个带上下边框的输入框，
 * 输入框一旦有过输入，主区域的品牌名与版本号就永久让位，即使随后清空也不再回来。回车把输入
 * 作为用户消息发到主区域，消息以三行灰色背景块展示。输入光标用终端自己的光标：画成闪烁
 * 竖线，并在每次重画后停到输入末尾。Ctrl+C 要连按两次才退出。
 */

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** 终端光标形状：5 是闪烁竖线，0 是恢复终端默认。 */
const CURSOR_BLINKING_BAR = "\x1b[5 q";
const CURSOR_DEFAULT = "\x1b[0 q";
/** 打开/关闭终端的焦点上报；关闭后终端不会再往输入里塞焦点事件。 */
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
/** 按钮事件上报加 SGR 坐标；按住拖动时也会收到移动事件。 */
const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/** Ctrl+C 在原始模式下以控制字符到达，不会触发 SIGINT，必须自己识别。 */
const CTRL_C = "\x03";
/** 第一次 Ctrl+C 之后等待第二次的时间；超过就回到未确认状态。 */
const EXIT_CONFIRM_WINDOW_MS = 2000;
/** 滚轮每格滚动多少行。 */
const WHEEL_STEP = 3;

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
	/** 已经发送的用户消息，按发送顺序排列。 */
	const messages: string[] = [];
	/** 只要输入过内容就置位，之后清空输入也不再显示品牌名与版本号。 */
	let hasInput = false;
	/** 终端窗口是否有焦点；界面启动时默认有焦点。 */
	let focused = true;
	/** 消息区从顶部往下滚过的行数；0 停在最新消息处。 */
	let scrollOffset = 0;
	/** 是否正按住滚动条拖动。 */
	let draggingScrollbar = false;
	let exitArmed = false;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let finish = (): void => {};
	const decoder = new StringDecoder("utf8");

	const render = (): void => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = terminalHeight(stdout);
		const footer = renderFooter(width, input, focused);
		const mainHeight = Math.max(0, height - FOOTER_HEIGHT);
		scrollOffset = Math.min(scrollOffset, Math.max(0, messageLineCount(messages) - mainHeight));
		const main =
			hasInput
				? renderMessages(width, mainHeight, messages, scrollOffset)
				: renderMain(width, mainHeight, options.version);
		// 原始模式下换行不再由终端补回车，必须显式写全，否则每一行会错位
		const lines = [...main, ...footer].slice(0, height);
		const cursorRow = mainHeight + 2;
		const cursor =
			focused && cursorRow <= height
				? moveCursor(cursorRow, inputView(input, width).column) + SHOW_CURSOR
				: "";
		stdout.write(HIDE_CURSOR + CURSOR_HOME + CLEAR_SCREEN + lines.join("\r\n") + cursor);
	};

	const disarm = (): void => {
		if (exitTimer !== undefined) {
			clearTimeout(exitTimer);
			exitTimer = undefined;
		}
		exitArmed = false;
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
		stdout.write(DISABLE_MOUSE + DISABLE_FOCUS_REPORTING + CURSOR_DEFAULT + SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN);
		finish();
	};

	const onCtrlC = (): void => {
		if (exitArmed) {
			cleanup();
			return;
		}
		exitArmed = true;
		exitTimer = setTimeout(disarm, EXIT_CONFIRM_WINDOW_MS);
	};

	/** 回车发送：把当前输入交给主区域，输入框清空。返回是否真的发生了可见变化。 */
	const submit = (): boolean => {
		if (input.length === 0) return false;

		const message = input.trim();
		input = "";
		if (message.length > 0) messages.push(message);
		// 新消息总是回到最上面
		scrollOffset = 0;
		render();
		return true;
	};

	const onData = (chunk: Buffer): void => {
		const text = decoder.write(chunk);
		if (text.includes(CTRL_C)) {
			onCtrlC();
			return;
		}

		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = terminalHeight(stdout);
		const mainHeight = Math.max(0, height - FOOTER_HEIGHT);
		const maxScroll = Math.max(0, messageLineCount(messages) - mainHeight);
		const beforeScroll = scrollOffset;
		const withoutMouse = stripMouseEvents(text);
		let focusChanged = false;
		let wheelSteps = 0;
		let dragRow: number | undefined;

		const lastIn = withoutMouse.lastIndexOf(FOCUS_IN);
		const lastOut = withoutMouse.lastIndexOf(FOCUS_OUT);
		if (lastIn >= 0 || lastOut >= 0) {
			const next = lastIn > lastOut;
			if (next !== focused) {
				focused = next;
				focusChanged = true;
			}
			if (!next) draggingScrollbar = false;
		}

		for (const event of mouseEvents(text)) {
			const left = (event.button & 3) === 0;
			const motion = event.button >= 32 && event.button < 64;

			if (event.press && event.button === 64) {
				wheelSteps -= 1;
			} else if (event.press && event.button === 65) {
				wheelSteps += 1;
			} else if (event.press && left && !motion) {
				const insideFooter = event.row >= Math.max(1, height - FOOTER_HEIGHT + 1);
				if (insideFooter !== focused) {
					focused = insideFooter;
					focusChanged = true;
				}
				if (!insideFooter && event.column === width && event.row <= mainHeight) {
					draggingScrollbar = true;
					dragRow = event.row;
				} else {
					draggingScrollbar = false;
				}
			} else if (event.press && left && motion) {
				if (draggingScrollbar) dragRow = event.row;
			} else if (!event.press) {
				draggingScrollbar = false;
			}
		}

		if (wheelSteps !== 0) {
			scrollOffset = Math.min(maxScroll, Math.max(0, scrollOffset + wheelSteps * WHEEL_STEP));
		}
		if (dragRow !== undefined) {
			scrollOffset = scrollTopFromRow(dragRow, mainHeight, maxScroll);
		}
		const scrollChanged = scrollOffset !== beforeScroll;

		const previous = input;
		const result = appendInput(input, withoutMouse);
		input = result.text;
		if (input.length > 0) hasInput = true;

		if (result.submit) {
			const submitted = submit();
			if (!submitted && (focusChanged || scrollChanged)) render();
			return;
		}
		if (input !== previous || focusChanged || scrollChanged) render();
	};

	const onInterrupt = (): void => {
		cleanup();
	};

	const done = new Promise<number>((resolve) => {
		finish = () => resolve(0);
	});

	try {
		stdout.write(
			ENTER_ALTERNATE_SCREEN + CURSOR_BLINKING_BAR + HIDE_CURSOR + ENABLE_FOCUS_REPORTING + ENABLE_MOUSE,
		);
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

function moveCursor(row: number, column: number): string {
	return `\x1b[${row};${column}H`;
}

function terminalHeight(output: TuiOutput): number {
	return Math.max(1, output.rows ?? DEFAULT_ROWS);
}

/** 去掉 SGR 鼠标事件，避免它们被当成普通输入。 */
function stripMouseEvents(text: string): string {
	return text.replace(/\x1b\[<[0-9;]+[Mm]/g, "");
}

interface MouseInput {
	readonly button: number;
	readonly column: number;
	readonly row: number;
	/** SGR 的 M 表示按下，m 表示松开 */
	readonly press: boolean;
}

function mouseEvents(text: string): readonly MouseInput[] {
	const events: MouseInput[] = [];
	for (const match of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
		events.push({
			button: Number(match[1]),
			column: Number(match[2]),
			row: Number(match[3]),
			press: match[4] === "M",
		});
	}
	return events;
}

/** 滚动条上某一行对应“从顶部往下滚多少行”。 */
function scrollTopFromRow(row: number, height: number, maxScroll: number): number {
	if (maxScroll === 0 || height <= 1) return 0;

	const clamped = Math.min(Math.max(1, row), height);
	return Math.round(((clamped - 1) / (height - 1)) * maxScroll);
}

/**
 * 把终端读到的字符并进输入框。
 *
 * 光标固定在最末，因此退格就是删掉最后一个字符；回车表示发送；方向键等转义序列整段丢弃，
 * 不能当成文字填进去。转义序列通常在一次读取里完整到达，所以状态只需在这次调用内保持。
 */
function appendInput(current: string, chunk: string): { text: string; submit: boolean } {
	let next = current;
	let submit = false;
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
		if (char === "\r" || char === "\n") {
			submit = true;
			break;
		}
		if (char === "\x7f" || char === "\b") {
			next = next.replace(/.$/u, "");
			continue;
		}
		if (char >= " ") next += char;
	}

	return { text: next, submit };
}
