import { THINKING_LEVELS, type ThinkingLevel } from "../config/config-file.ts";
import {
	ACCENT_COLOR,
	BOLD_OFF,
	MENU_MAX_VISIBLE,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	TEXT_COLOR,
	bottomBorder,
	displayWidth,
	keepVisible,
	menuHeight,
	padEnd,
	padStart,
	topBorder,
} from "./menu-panel.ts";

/**
 * 思考等级选择面板。
 *
 * 级别清单直接取配置层的 THINKING_LEVELS，避免界面和校验各维护一份。面板样式与模型面板
 * 一致，只保留级别名与 current 标记。
 */

export interface EffortMenuState {
	readonly current: ThinkingLevel;
	cursor: number;
	scrollTop: number;
}

const PREFIX_WIDTH = 3;
const GAP = 2;
const CURRENT_WIDTH = 7;

/** 用使用场景说明每个等级，光看 low/high 这些缩写很难判断该选哪个。 */
const EFFORT_DESCRIPTIONS: Readonly<Record<ThinkingLevel, string>> = {
	off: "No reasoning; fastest responses",
	low: "Quick tasks where you review each result",
	medium: "Everyday work with a clear scope",
	high: "Work where correctness and edge cases matter",
	xhigh: "Deeper reasoning with higher token cost",
	max: "Hard problems that need sustained reasoning",
};

export function effortMenuHeight(): number {
	return menuHeight(THINKING_LEVELS.length);
}

export function renderEffortMenu(width: number, state: EffortMenuState): readonly string[] {
	const visibleCount = Math.min(THINKING_LEVELS.length, MENU_MAX_VISIBLE);
	const top = keepVisible(state.scrollTop, state.cursor, THINKING_LEVELS.length);
	const levelWidth = Math.max(...THINKING_LEVELS.map(displayWidth));
	const currentWidth =
		width >= PREFIX_WIDTH + levelWidth + GAP + CURRENT_WIDTH ? CURRENT_WIDTH : 0;
	const descriptionWidth =
		currentWidth > 0
			? Math.max(0, width - PREFIX_WIDTH - levelWidth - GAP - GAP - currentWidth)
			: Math.max(0, width - PREFIX_WIDTH - levelWidth - GAP);
	const lines: string[] = [topBorder(width, THINKING_LEVELS.length)];

	for (let offset = 0; offset < visibleCount; offset += 1) {
		const level = THINKING_LEVELS[top + offset];
		if (level === undefined) break;
		lines.push(
			row(
				width,
				level,
				top + offset === state.cursor,
				level === state.current,
				levelWidth,
				descriptionWidth >= 4 ? descriptionWidth : 0,
				currentWidth,
			),
		);
	}

	lines.push(bottomBorder(width));
	return lines;
}

function row(
	width: number,
	level: ThinkingLevel,
	selected: boolean,
	current: boolean,
	levelWidth: number,
	descriptionWidth: number,
	currentWidth: number,
): string {
	const prefix = selected ? " › " : "   ";
	const primaryColor = selected ? SELECTED_TEXT_COLOR : TEXT_COLOR;
	const boldOff = selected ? BOLD_OFF : "";
	const prefixOutput = selected
		? ` ${ACCENT_COLOR}›${primaryColor} `
		: prefix;
	const levelText = padEnd(level, levelWidth);
	const description =
		descriptionWidth > 0 ? padEnd(EFFORT_DESCRIPTIONS[level], descriptionWidth) : "";
	const descriptionSegment =
		descriptionWidth > 0 ? `${" ".repeat(GAP)}${description}` : "";
	const currentText = currentWidth > 0 ? padStart(current ? "current" : "", currentWidth) : "";
	const currentSegment = currentWidth > 0 ? `${" ".repeat(GAP)}${currentText}` : "";
	const head = `${prefix}${levelText}${descriptionSegment}${currentSegment}`;
	const padding = " ".repeat(Math.max(0, width - displayWidth(head)));
	const descriptionOutput =
		descriptionWidth > 0 ? `${" ".repeat(GAP)}${MUTED_COLOR}${description}` : "";
	const currentOutput =
		currentWidth > 0 ? `${" ".repeat(GAP)}${ACCENT_COLOR}${currentText}` : "";

	return `${PANEL_BG}${primaryColor}${prefixOutput}${levelText}${boldOff}${descriptionOutput}${currentOutput}${padding}${RESET}`;
}
