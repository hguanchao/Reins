import type { Line, Style } from "../../tui/index.ts";
import { ACCENT, EDGE_LIT, FAINT } from "./theme.ts";

/**
 * 回合轨道。
 *
 * 一格刻度代表一个回合，位置只表示会话里的先后顺序，不表示滚动的比例——进度条能告诉你
 * 「看到哪儿了」，轨道告诉你「哪几个回合在屏幕里」。视口顶端所在的那个回合点亮，另外两个
 * 回合（视口上方最近的、下方最近的）由两端的箭头指向；翻到顶或翻到底时对应的箭头变暗。
 *
 * 太窄的终端不放轨道：会话内容比导航更需要那几列。
 */

/** 轨道占的列数。刻度两列宽，箭头一列宽，取两者里宽的那个。 */
export const RAIL_WIDTH = 2;

/** 窄于这个宽度就不放轨道。 */
const MIN_WIDTH = 60;

/** 只有一个回合时轨道没有意义，那点空间不如留给正文。 */
const MIN_TURNS = 2;

const CHEVRON_UP = "▴";
const CHEVRON_DOWN = "▾";

/** 一格刻度。文本按两列宽对齐，调用方直接拼到行尾。 */
export interface RailCell {
	readonly text: string;
	readonly style: Style | undefined;
}

const BLANK: RailCell = { text: "  ", style: undefined };

/** 轨道要不要出现：够宽，而且回合已经多到值得导航。 */
export function railWidth(options: { readonly width: number; readonly turns: number }): number {
	if (options.width < MIN_WIDTH) return 0;
	if (options.turns < MIN_TURNS) return 0;
	return RAIL_WIDTH;
}

/**
 * 算出轨道的每一格。
 *
 * `turns` 是每个回合起始行的行号（升序），`top` 是视口顶端所在的行号。返回的长度就是主区
 * 高度，每格要么是箭头、要么是刻度、要么是空的。
 */
export function railCells(rows: number, turns: readonly number[], top: number): readonly RailCell[] {
	const cells: RailCell[] = new Array<RailCell>(Math.max(0, rows)).fill(BLANK);
	if (rows < 4 || turns.length === 0) return cells;

	const active = activeTurn(turns, top);
	const hasAbove = turns.some((turn) => turn < top);
	const hasBelow = turns.some((turn) => turn > top);

	cells[0] = { text: ` ${CHEVRON_UP}`, style: hasAbove ? EDGE_LIT : FAINT };
	cells[rows - 1] = { text: ` ${CHEVRON_DOWN}`, style: hasBelow ? EDGE_LIT : FAINT };

	// 中间留给刻度：装得下就整体居中，装不下就以当前回合为中心开一扇窗
	const area = rows - 2;
	const visible = turns.length <= area ? turns : window(turns, active, area);
	const first = 1 + Math.floor((area - visible.length) / 2);
	visible.forEach((turn, index) => {
		const lit = turn === active;
		cells[first + index] = { text: lit ? "━━" : "─ ", style: lit ? ACCENT : FAINT };
	});

	return cells;
}

/** 视口顶端落在哪个回合里：起始行不超过顶端的那最后一个。 */
export function activeTurn(turns: readonly number[], top: number): number {
	let active = turns[0] ?? 0;
	for (const turn of turns) {
		if (turn > top) break;
		active = turn;
	}
	return active;
}

/** 以当前回合为中心、不超过 area 个刻度的那一段。 */
function window(turns: readonly number[], active: number, area: number): readonly number[] {
	const at = Math.max(0, turns.indexOf(active));
	const half = Math.floor(area / 2);
	const start = Math.min(Math.max(0, at - half), Math.max(0, turns.length - area));
	return turns.slice(start, start + area);
}

/** 把一格轨道接到一行末尾。 */
export function appendRail(line: Line, cell: RailCell): Line {
	const span = cell.style === undefined ? { text: cell.text } : { text: cell.text, style: cell.style };
	return [...line, span];
}
