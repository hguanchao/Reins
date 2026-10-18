import { eastAsianWidth } from "get-east-asian-width";
import { StringDecoder } from "node:string_decoder";

import { FOOTER_HEIGHT, inputView, renderFooter } from "./footer.ts";
import { renderMain } from "./main.ts";
import { renderTranscript, transcriptMetrics, type TranscriptTurn } from "./transcript.ts";

/**
 * 全屏启动。
 *
 * 进入终端的备用屏，按当前尺寸铺满整个窗口；尺寸变化时重画。页脚是带运行时状态和输入框的
 * 区域。回车把输入作为用户提示送进对话流，提示落在视口顶部；模拟回复在它下方流式增长，
 * 回复滚出视口后提示块吸顶。Ctrl+C 要连按两次才退出。
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
/** 运行时状态前的加载动画。 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 100;
/** 每帧把扫光往前推多少；整个状态行约 1.25 秒扫一遍。 */
const SWEEP_STEP = 0.08;
/** 滚轮速度映射：间隔越短，单格滚得越多。 */
const WHEEL_BASE_STEP = 2;
const WHEEL_MAX_STEP = 12;
const WHEEL_SLOW_INTERVAL_MS = 250;

const WAITING_FOR_RESPONSE = "Waiting for response...";
const THINKING = "Thinking...";
const WRITING_RESPONSE = "Writing response...";
const DONE = "Done";

/** 模拟回复的节奏：前 0.5 秒等待，再 0.5 秒思考，然后每帧写一行。 */
const MOCK_WAITING_TICKS = 5;
const MOCK_THINKING_TICKS = 5;
const MOCK_DONE_TICKS = 10;
const MOCK_REPLY_LINES = Array.from(
	{ length: 48 },
	(_, index) => `模拟回复第 ${index + 1} 行：用户提示固定在顶部，回复内容在下面滚动。`,
);

interface MockTurn extends TranscriptTurn {
	response: string[];
}

interface MockState {
	readonly turn: MockTurn;
	tick: number;
	phase: "waiting" | "thinking" | "writing" | "done";
	/** 当前阶段从哪一帧开始，用来显示阶段计时。 */
	phaseStartTick: number;
	doneTick: number | undefined;
}

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
	const turns: MockTurn[] = [];
	/** 只要输入过内容就置位，之后清空输入也不再显示品牌名与版本号。 */
	let hasInput = false;
	/** 终端窗口是否有焦点；界面启动时默认有焦点。 */
	let focused = true;
	/** 对话流从顶部滚过的行数。 */
	let scrollTop = 0;
	/** 是否跟随新内容滚到底部。 */
	let follow = true;
	/** 上一次滚轮事件的时间，用来算滚轮速度。 */
	let lastWheelAt: number | undefined;
	/** 是否正按住滚动条拖动。 */
	let draggingScrollbar = false;
	/** 当前运行时状态；为空表示空闲。 */
	let statusText: string | undefined;
	let statusPhaseMs = 0;
	let statusElapsedMs = 0;
	let statusTokens = 0;
	let spinnerFrame = 0;
	let sweepPhase = 0;
	let mock: MockState | undefined;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let exitArmed = false;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let finish = (): void => {};
	const decoder = new StringDecoder("utf8");

	const render = (): void => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = terminalHeight(stdout);
		const mainHeight = Math.max(0, height - FOOTER_HEIGHT);
		const metrics = transcriptMetrics(width, mainHeight, turns);
		const maxScroll = Math.max(0, metrics.scrollLines - mainHeight);
		scrollTop = Math.min(scrollTop, maxScroll);

		const status =
			statusText === undefined
				? undefined
				: {
						symbol: SPINNER_FRAMES[spinnerFrame] ?? "",
						text: statusText,
						sweep: sweepPhase,
						phaseMs: statusPhaseMs,
						elapsedMs: statusElapsedMs,
						tokens: statusTokens,
					};
		const footer = renderFooter(width, input, focused, status);
		const main = hasInput
			? renderTranscript(width, mainHeight, turns, scrollTop)
			: renderMain(width, mainHeight, options.version);
		// 原始模式下换行不再由终端补回车，必须显式写全，否则每一行会错位
		const lines = [...main, ...footer].slice(0, height);
		const cursorRow = mainHeight + 3;
		const cursor =
			focused && cursorRow <= height
				? moveCursor(cursorRow, inputView(input, width).column) + SHOW_CURSOR
				: "";
		stdout.write(HIDE_CURSOR + CURSOR_HOME + CLEAR_SCREEN + lines.join("\r\n") + cursor);
	};

	const maxScroll = (): number => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const mainHeight = Math.max(0, terminalHeight(stdout) - FOOTER_HEIGHT);
		return Math.max(0, transcriptMetrics(width, mainHeight, turns).scrollLines - mainHeight);
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
		if (spinnerTimer !== undefined) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
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

	const advanceMock = (): boolean => {
		if (mock === undefined) return false;

		mock.tick += 1;
		statusElapsedMs = mock.tick * SPINNER_INTERVAL_MS;

		if (mock.phase === "waiting" && mock.tick >= MOCK_WAITING_TICKS) {
			mock.phase = "thinking";
			mock.phaseStartTick = mock.tick;
		}
		if (mock.phase === "thinking" && mock.tick >= MOCK_WAITING_TICKS + MOCK_THINKING_TICKS) {
			mock.phase = "writing";
			mock.phaseStartTick = mock.tick;
		}

		if (mock.phase === "writing") {
			const next = MOCK_REPLY_LINES[mock.turn.response.length];
			if (next !== undefined) {
				mock.turn.response.push(next);
				statusTokens = estimateTokens(mock.turn.response.join(" "));
			}
			if (mock.turn.response.length >= MOCK_REPLY_LINES.length) {
				mock.phase = "done";
				mock.phaseStartTick = mock.tick;
				mock.doneTick = mock.tick;
				statusText = DONE;
			} else {
				statusText = WRITING_RESPONSE;
			}
			if (follow) scrollTop = maxScroll();
		} else if (mock.phase === "thinking") {
			statusText = THINKING;
		} else if (mock.phase === "waiting") {
			statusText = WAITING_FOR_RESPONSE;
		}

		statusPhaseMs = (mock.tick - mock.phaseStartTick) * SPINNER_INTERVAL_MS;

		if (mock.phase === "done" && mock.doneTick !== undefined && mock.tick - mock.doneTick >= MOCK_DONE_TICKS) {
			mock = undefined;
			statusText = undefined;
			statusPhaseMs = 0;
			statusElapsedMs = 0;
			statusTokens = 0;
			return false;
		}

		return true;
	};

	const startSpinner = (): void => {
		if (spinnerTimer !== undefined) return;

		spinnerTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			sweepPhase = (sweepPhase + SWEEP_STEP) % 1;
			const active = advanceMock();
			render();
			if (!active) {
				if (spinnerTimer !== undefined) {
					clearInterval(spinnerTimer);
					spinnerTimer = undefined;
				}
			}
		}, SPINNER_INTERVAL_MS);
	};

	/** 回车发送：把当前输入交给对话流，并启动一次模拟回复。 */
	const submit = (): boolean => {
		if (input.length === 0) return false;

		const message = input.trim();
		input = "";
		if (message.length > 0) {
			const turn: MockTurn = { prompt: message, response: [] };
			turns.push(turn);
			mock = { turn, tick: 0, phase: "waiting", phaseStartTick: 0, doneTick: undefined };
			statusText = WAITING_FOR_RESPONSE;
			statusPhaseMs = 0;
			statusElapsedMs = 0;
			statusTokens = 0;
			follow = true;

			const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
			const mainHeight = Math.max(0, terminalHeight(stdout) - FOOTER_HEIGHT);
			scrollTop = transcriptMetrics(width, mainHeight, turns).lastPromptStart;
			startSpinner();
		}
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
		const limit = maxScroll();
		const beforeScroll = scrollTop;
		const withoutMouse = stripMouseEvents(text);
		let focusChanged = false;
		let wheelDelta = 0;
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
				const now = Date.now();
				const interval = lastWheelAt === undefined ? Number.POSITIVE_INFINITY : now - lastWheelAt;
				lastWheelAt = now;
				wheelDelta -= wheelStepForInterval(interval);
			} else if (event.press && event.button === 65) {
				const now = Date.now();
				const interval = lastWheelAt === undefined ? Number.POSITIVE_INFINITY : now - lastWheelAt;
				lastWheelAt = now;
				wheelDelta += wheelStepForInterval(interval);
			} else if (event.press && left && !motion) {
				const insideInput = event.row >= Math.max(1, height - 2);
				if (insideInput !== focused) {
					focused = insideInput;
					focusChanged = true;
				}
				if (!insideInput && event.column === width && event.row <= mainHeight && turns.length > 0) {
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

		if (wheelDelta !== 0) {
			scrollTop = Math.min(limit, Math.max(0, scrollTop + wheelDelta));
			follow = scrollTop >= limit;
		}
		if (dragRow !== undefined) {
			scrollTop = scrollTopFromRow(dragRow, mainHeight, limit);
			follow = scrollTop >= limit;
		}
		const scrollChanged = scrollTop !== beforeScroll;

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

function terminalHeight(output: TuiOutput): number {
	return Math.max(1, output.rows ?? DEFAULT_ROWS);
}

function moveCursor(row: number, column: number): string {
	return `\x1b[${row};${column}H`;
}

function estimateTokens(text: string): number {
	let wide = 0;
	for (const char of text) {
		if (eastAsianWidth(char.codePointAt(0) ?? 0) === 2) wide += 1;
	}
	return wide + Math.ceil((text.length - wide) / 4);
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

function scrollTopFromRow(row: number, height: number, maxScroll: number): number {
	if (maxScroll === 0 || height <= 1) return 0;

	const clamped = Math.min(Math.max(1, row), height);
	return Math.round(((clamped - 1) / (height - 1)) * maxScroll);
}

/** 两次滚轮之间的间隔越短，这一格滚得越多；停下后再滚回到基础步长。 */
export function wheelStepForInterval(intervalMs: number): number {
	if (!Number.isFinite(intervalMs) || intervalMs >= WHEEL_SLOW_INTERVAL_MS) return WHEEL_BASE_STEP;

	const factor = WHEEL_SLOW_INTERVAL_MS / Math.max(1, intervalMs);
	return Math.min(WHEEL_MAX_STEP, Math.max(WHEEL_BASE_STEP, Math.round(WHEEL_BASE_STEP * factor)));
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
