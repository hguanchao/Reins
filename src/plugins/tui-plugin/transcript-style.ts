import { concat, plain, styled, type Line, type Rgb, type Style } from "../../tui/text/line.ts";
import { BLOCK_PAD_LEFT } from "./layout.ts";
import { THEME } from "./theme.ts";

/**
 * 块的行样式。
 *
 * 每个块最左边一列是竖线：思考和工具用彩色，模型正文留空但保留同样的列宽。正在运行的块
 * 用一条沿行号错开相位的明暗波，静态底色不会让人误以为卡住了。
 */

const BAR = "┃";
const PULSE_RADIANS_PER_MS = 1 / 240;
const PULSE_MIN = 0.35;

/** 块的左竖线；没有颜色时留一格空白，正文列不会因为块类型而漂移。 */
export function rail(style: Style | undefined): Line {
	return style === undefined ? plain(" ") : styled(BAR, style);
}

/** 竖线、正文前留白与正文。 */
export function blockLine(accent: Line, content: Line): Line {
	return concat(accent, plain(" ".repeat(BLOCK_PAD_LEFT)), content);
}

/** 模型正文没有竖线，但仍保留竖线列与左留白，和工具行从同一列开始。 */
export function agentLine(line: Line): Line {
	return line.length === 0 ? [] : blockLine(plain(" "), line);
}

/** 运行中块的强调色：沿行号错开相位的明暗波。 */
export function pulseStyle(now: number, row = 0): Style {
	const wave = (Math.sin(now * PULSE_RADIANS_PER_MS + row * 0.9) + 1) / 2;
	return { color: blend(THEME.base, THEME.accent, PULSE_MIN + (1 - PULSE_MIN) * wave) };
}

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
	return [
		Math.round(from[0] + (to[0] - from[0]) * amount),
		Math.round(from[1] + (to[1] - from[1]) * amount),
		Math.round(from[2] + (to[2] - from[2]) * amount),
	];
}
