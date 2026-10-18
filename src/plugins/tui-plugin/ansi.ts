import {
	mergeStyles,
	type Color,
	type Line,
	type Rgb,
	type Span,
	type Style,
} from "../../tui/index.ts";

/**
 * 把带 ANSI 颜色的工具输出还原成带样式的行。
 *
 * 只处理 SGR（`ESC[...m`）：颜色、粗体、斜体、下划线、反显与删除线。光标移动、清屏、
 * 超链接等序列本身不表达文字，直接丢弃。这样命令输出里的彩色警告、diff 与进度条不会变成
 * 一串乱码，也不会改掉界面自己的样式。
 *
 * 回车按终端的覆盖语义处理：单独一个 `\r` 清掉当前行，后续内容从行首重新写；`\r\n` 按
 * 普通换行处理。进度条因此只留下最后的状态。
 */

/** 终端标准 16 色。 */
const PALETTE: readonly Rgb[] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

/** 可变的 SGR 状态；跨行保留，直到遇到 reset。 */
interface SgrState {
	color?: Color;
	background?: Color;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	reverse?: boolean;
	strikethrough?: boolean;
}

export function ansiLines(text: string, base: Style): readonly Line[] {
	const lines: Line[] = [];
	let spans: Span[] = [];
	let chunk = "";
	let state: SgrState = {};

	const flushChunk = (): void => {
		if (chunk.length === 0) return;
		const style = mergeStyles(base, styleOf(state));
		spans.push(style === undefined ? { text: chunk } : { text: chunk, style });
		chunk = "";
	};
	const flushLine = (): void => {
		flushChunk();
		lines.push(spans);
		spans = [];
	};

	let index = 0;
	while (index < text.length) {
		const char = text[index];

		if (char === "\x1b") {
			const next = text[index + 1];
			if (next === "[") {
				const end = csiEnd(text, index + 2);
				if (end < 0) break;
				const params = text.slice(index + 2, end);
				if (text[end] === "m") {
					flushChunk();
					state = applySgr(state, params);
				}
				index = end + 1;
				continue;
			}
			if (next === "]") {
				index = skipOsc(text, index + 2);
				continue;
			}
			// 其他 ESC 序列不表达文字：跳过 ESC 与紧随的一个字符
			index += 2;
			continue;
		}

		if (char === "\n") {
			flushLine();
			index += 1;
			continue;
		}
		if (char === "\r") {
			if (text[index + 1] === "\n") {
				flushLine();
				index += 2;
				continue;
			}
			// 覆盖当前行：进度条反复重写同一行，只保留最后一次的内容
			chunk = "";
			spans = [];
			index += 1;
			continue;
		}
		if (char === "\t" || char >= " ") {
			chunk += char;
		}
		index += 1;
	}

	flushLine();
	return lines;
}

/** CSI 的结束位置：参数与中间字节之后的首个终止字符。 */
function csiEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index;
	}
	return -1;
}

/** 跳过 OSC（标题、超链接），返回结束标记之后的位置。 */
function skipOsc(text: string, start: number): number {
	for (let index = start; index < text.length; index += 1) {
		if (text[index] === "\x07") return index + 1;
		if (text[index] === "\x1b" && text[index + 1] === "\\") return index + 2;
	}
	return text.length;
}

function applySgr(previous: SgrState, params: string): SgrState {
	const state: SgrState = { ...previous };
	const values = params
		.split(";")
		.map((value) => (value.length === 0 ? 0 : Number(value)))
		.map((value) => (Number.isFinite(value) ? value : 0));

	for (let index = 0; index < values.length; index += 1) {
		const code = values[index];
		if (code === 0) {
			for (const key of Object.keys(state) as (keyof SgrState)[]) delete state[key];
			continue;
		}
		if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = true;
		else if (code === 7) state.reverse = true;
		else if (code === 9) state.strikethrough = true;
		else if (code === 22) {
			delete state.bold;
			delete state.dim;
		} else if (code === 23) delete state.italic;
		else if (code === 24) delete state.underline;
		else if (code === 27) delete state.reverse;
		else if (code === 29) delete state.strikethrough;
		else if (code >= 30 && code <= 37) state.color = PALETTE[code - 30];
		else if (code === 39) delete state.color;
		else if (code >= 40 && code <= 47) state.background = PALETTE[code - 40];
		else if (code === 49) delete state.background;
		else if (code >= 90 && code <= 97) state.color = PALETTE[code - 90 + 8];
		else if (code >= 100 && code <= 107) state.background = PALETTE[code - 100 + 8];
		else if (code === 38 || code === 48) {
			const mode = values[index + 1];
			if (mode === 5) {
				const color = color256(values[index + 2] ?? 0);
				if (code === 38) state.color = color;
				else state.background = color;
				index += 2;
			} else if (mode === 2) {
				const color = rgb(values[index + 2], values[index + 3], values[index + 4]);
				if (code === 38) state.color = color;
				else state.background = color;
				index += 4;
			}
		}
	}
	return state;
}

function styleOf(state: SgrState): Style | undefined {
	const style: Style = { ...state };
	return Object.keys(style).length === 0 ? undefined : style;
}

function rgb(red: number | undefined, green: number | undefined, blue: number | undefined): Rgb {
	const channel = (value: number | undefined): number =>
		Math.max(0, Math.min(255, Math.round(value ?? 0)));
	return [channel(red), channel(green), channel(blue)];
}

function color256(value: number): Rgb {
	const index = Math.max(0, Math.min(255, Math.round(value)));
	if (index < 16) return PALETTE[index];
	if (index < 232) {
		const offset = index - 16;
		const steps = [0, 95, 135, 175, 215, 255] as const;
		return [steps[Math.floor(offset / 36)], steps[Math.floor((offset % 36) / 6)], steps[offset % 6]];
	}
	const gray = 8 + (index - 232) * 10;
	return [gray, gray, gray];
}
