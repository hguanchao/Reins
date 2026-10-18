import {
	alignEnds,
	concat,
	lineWidth,
	plain,
	styled,
	truncateLine,
	type Line,
	type Span,
	type Style,
} from "../../tui/index.ts";
import { formatTokens } from "./format.ts";
import { OUTER_PAD } from "./layout.ts";
import { BAD, DIM, FAINT, THEME } from "./theme.ts";

/**
 * 顶部的状态行。
 *
 * 左边回答「我在哪」：分支、工作目录、沙箱；右边回答「上下文还剩多少」。这行不参与会话
 * 滚动，翻历史时也一直看得见。
 *
 * 上下文默认写成 `已用 / 上限`，指针停在上面时换成进度条——平时占用不该抢正文的注意力，
 * 需要细看时再展开。宽度不够时先丢右边的占用条，再丢沙箱标记，目录最后才截。
 */

/** 一个字长八格的进度条字符。 */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** 进度条占几列。 */
const BAR_WIDTH = 10;

export interface TopBarState {
	readonly width: number;
	readonly branch: string | undefined;
	readonly cwd: string;
	readonly sandbox: string;
	/** 当前上下文估算 token */
	readonly used: number;
	/** 上下文上限；未声明时为 undefined，不显示占用条 */
	readonly total: number | undefined;
	/** 指针是否停在上下文占用条上 */
	readonly hover: boolean;
}

export interface TopBarRender {
	readonly line: Line;
	/** 上下文占用条在整行里的列范围；没有占用条时省略 */
	readonly context?: { readonly from: number; readonly to: number };
}

export function topBarRow(state: TopBarState): TopBarRender {
	const margin = plain(" ".repeat(OUTER_PAD));
	const leftParts: Line[] = [margin];
	if (state.branch !== undefined) {
		leftParts.push(styled("⎇ ", FAINT), styled(state.branch, { color: THEME.text }), plain("  "));
	}
	leftParts.push(styled(shortenPath(state.cwd, Math.max(16, Math.floor(state.width / 3))), DIM));

	const right = rightChips(state);
	const left = truncateLine(concat(...leftParts), state.width);
	if (right === undefined) return { line: left };

	const line = alignEnds(left, right.line, state.width);
	// alignEnds 放不下时返回左段，占用条的列范围也就不存在
	if (lineWidth(line) < lineWidth(right.line)) return { line: left };
	if (!right.hasContext) return { line };
	const from = state.width - lineWidth(right.line) + right.contextOffset;
	return { line, context: { from, to: state.width } };
}

/** 右侧标记：沙箱与上下文占用。放不下时整组丢弃，而不是把文字截成半截。 */
function rightChips(
	state: TopBarState,
): { readonly line: Line; readonly contextOffset: number; readonly hasContext: boolean } | undefined {
	const chips: { readonly line: Line; readonly plainWidth: number; readonly context: boolean }[] = [];

	if (state.sandbox !== "off") {
		const label = `sandbox:${state.sandbox}`;
		chips.push({
			line: styled(label, { color: THEME.warn }),
			plainWidth: label.length,
			context: false,
		});
	}

	if (state.total !== undefined && state.total > 0) {
		const ratio = Math.max(0, Math.min(1, state.used / state.total));
		const style = contextStyle(ratio);
		const label = state.hover ? contextBar(ratio) : `${formatTokens(state.used)} / ${formatTokens(state.total)}`;
		chips.push({ line: styled(label, style), plainWidth: lineWidth(styled(label, style)), context: true });
	}

	if (chips.length === 0) return undefined;

	const separator = styled("  │  ", FAINT);
	const parts: Span[] = [];
	let contextOffset = 0;
	let plainWidth = 0;
	for (let index = 0; index < chips.length; index += 1) {
		const chip = chips[index];
		if (index > 0) {
			parts.push(...separator);
			plainWidth += 5;
		}
		if (chip.context) contextOffset = plainWidth;
		parts.push(...chip.line);
		plainWidth += chip.plainWidth;
	}

	// 左侧至少要有分支/目录的一点位置；右侧整组放不下时不画
	if (plainWidth + OUTER_PAD + 8 > state.width) return undefined;
	return { line: parts, contextOffset, hasContext: chips.some((chip) => chip.context) };
}

/** 占用越高越警示：从正文色平滑过渡到用户色、黄色，最后到红色。 */
function contextStyle(ratio: number): Style {
	const stops = [
		{ at: 0, color: THEME.text },
		{ at: 0.5, color: THEME.bright },
		{ at: 0.75, color: THEME.warn },
		{ at: 0.95, color: THEME.bad },
	] as const;
	const clamped = Math.max(0, Math.min(1, ratio));
	for (let index = 1; index < stops.length; index += 1) {
		const previous = stops[index - 1];
		const next = stops[index];
		if (clamped > next.at) continue;
		const span = next.at - previous.at;
		const amount = span === 0 ? 0 : (clamped - previous.at) / span;
		return { color: blend(previous.color, next.color, amount) };
	}
	return BAD;
}

function blend(from: readonly number[], to: readonly number[], amount: number): [number, number, number] {
	const mix = (index: number): number =>
		Math.round((from[index] ?? 0) + ((to[index] ?? 0) - (from[index] ?? 0)) * amount);
	return [mix(0), mix(1), mix(2)];
}

/** 悬停时显示的进度条：实心块按八分之一列递增，未填部分用浅轨道。 */
function contextBar(ratio: number): string {
	const filled = ratio * BAR_WIDTH;
	let full = Math.floor(filled);
	let eighth = Math.round((filled - full) * 8);
	if (eighth === 8) {
		full += 1;
		eighth = 0;
	}
	const bar = `${"█".repeat(full)}${EIGHTHS[eighth]}${"░".repeat(Math.max(0, BAR_WIDTH - full - (eighth > 0 ? 1 : 0)))}`;
	const percent = ratio >= 1 ? "100%" : `${(ratio * 100).toFixed(1)}%`;
	return `${bar} ${percent}`;
}

/** 路径太长时从前面收，保留最后几段；反斜杠统一成斜杠。 */
export function shortenPath(path: string, maxWidth: number): string {
	const normalized = path.replaceAll("\\", "/");
	if (normalized.length <= maxWidth) return normalized;

	const parts = normalized.split("/").filter((part) => part.length > 0);
	let tail = parts.at(-1) ?? normalized;
	for (let index = parts.length - 2; index >= 0; index -= 1) {
		const next = `${parts[index]}/${tail}`;
		if (next.length + 2 > maxWidth) break;
		tail = next;
	}
	const shortened = `…/${tail}`;
	return shortened.length <= maxWidth ? shortened : shortened.slice(-maxWidth);
}
