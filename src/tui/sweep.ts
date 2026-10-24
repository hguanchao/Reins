import { THEME } from "./theme.ts";

/**
 * 扫光：让一段静止的文字出现一道来回移动的亮带。
 *
 * 页脚运行时状态与对话流任务卡片共用这一份实现——同一道光只能有一个算法，基色与高亮色
 * 由调用方给出。
 */

/** RGB 三元组;theme 里只有少数颜色需要同时给 SGR 与裸数值，这里只认数值。 */
type Rgb = { readonly r: number; readonly g: number; readonly b: number };

/** 扫光带的半径(字符数):再大就会把整行一起提亮，失去「一道光」的观感。 */
const SWEEP_RADIUS = 6;

/**
 * 按相位给每个字符着色：以 phase位置为中心，向两侧线性衰减到基色，中心到达高亮色。
 *
 * phase 在 0 到 1 之间循环；调用方按帧推进它，光带就会来回扫过整段文字。
 */
export function swept(
	text: string,
	phase: number,
	base: Rgb,
	highlight: Rgb,
	radius: number = SWEEP_RADIUS,
): string {
	const center = -radius + phase * (text.length + radius * 2);
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		const distance = Math.abs(index - center);
		const intensity = Math.max(0, 1 - distance / radius);
		const r = Math.round(base.r + (highlight.r - base.r) * intensity);
		const g = Math.round(base.g + (highlight.g - base.g) * intensity);
		const b = Math.round(base.b + (highlight.b - base.b) * intensity);
		output += `\x1b[38;2;${r};${g};${b}m${text[index]}`;
	}
	return output + THEME.reset;
}
