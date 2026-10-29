import { THINKING_LEVELS, type ThinkingLevel } from "../../config/file.ts";
import { displayWidth } from "../render/text.ts";
import {
	type MenuListState,
	MENU_MAX_VISIBLE,
	menuListHeight,
	menuListLines,
	padEnd,
	padStart,
	ACCENT_COLOR,
	BOLD_OFF,
	HOVER_BG,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	TEXT_COLOR,
} from "./menu-panel.ts";

/**
 * 思考等级选择面板。
 *
 * 级别清单直接取配置层的 THINKING_LEVELS，避免界面和校验各维护一份。面板样式与模型面板
 * 一致，只保留级别名与 current 标记。
 */

export interface EffortMenuState extends MenuListState {
	readonly current: ThinkingLevel;
	/** 级别清单与 THINKING_LEVELS 相同；收进状态让五种面板的公共操作不必特判 */
	readonly items: readonly ThinkingLevel[];
}

const PREFIX_WIDTH = 3;
/** 相邻两列之间的间距。 */
const GAP = 4;
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

export function effortMenuHeight(maxVisible = MENU_MAX_VISIBLE): number {
	return menuListHeight(THINKING_LEVELS.length, undefined, maxVisible);
}

export function renderEffortMenu(
	width: number,
	state: EffortMenuState,
	maxVisible = MENU_MAX_VISIBLE,
): readonly string[] {
	const levelWidth = Math.max(...THINKING_LEVELS.map(displayWidth));
	const currentWidth =
		width >= PREFIX_WIDTH + levelWidth + GAP + CURRENT_WIDTH ? CURRENT_WIDTH : 0;
	const descriptionWidth =
		currentWidth > 0
			? Math.max(0, width - PREFIX_WIDTH - levelWidth - GAP - GAP - currentWidth)
			: Math.max(0, width - PREFIX_WIDTH - levelWidth - GAP);

	return menuListLines(
		width,
		THINKING_LEVELS,
		state,
		() => ({ levelWidth, currentWidth, descriptionWidth }),
		(_columns, level, selected, hovered, layout) =>
			row(
				width,
				level,
				selected,
				hovered,
				level === state.current,
				layout.levelWidth,
				layout.descriptionWidth >= 4 ? layout.descriptionWidth : 0,
				layout.currentWidth,
			),
		undefined,
		maxVisible,
	);
}

function row(
	width: number,
	level: ThinkingLevel,
	selected: boolean,
	hovered: boolean,
	current: boolean,
	levelWidth: number,
	descriptionWidth: number,
	currentWidth: number,
): string {
	const background = selected ? PANEL_BG : hovered ? HOVER_BG : PANEL_BG;
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

	return `${background}${primaryColor}${prefixOutput}${levelText}${boldOff}${descriptionOutput}${currentOutput}${padding}${RESET}`;
}
