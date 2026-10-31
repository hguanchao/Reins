import { inputView, queueHeight } from "#src/tui/view/footer.ts";
import { approvalPanelHeight } from "#src/tui/panel/approval-panel.ts";
import { commandMenuHeight } from "#src/tui/panel/command-menu.ts";
import { effortMenuHeight } from "#src/tui/panel/effort-menu.ts";
import { fileMenuHeight } from "#src/tui/panel/file-menu.ts";
import { skillMenuHeight } from "#src/tui/panel/skill-menu.ts";
import { modelMenuHeight } from "#src/tui/panel/model-menu.ts";
import { sessionMenuHeight } from "#src/tui/panel/session-menu.ts";
import { MENU_MAX_VISIBLE } from "#src/tui/panel/menu-panel.ts";
import { DEFAULT_COLUMNS, terminalHeight } from "#src/tui/terminal.ts";
import { todoCardFinished, TODO_PANEL_MAX_ITEMS } from "#src/tui/view/todo-card.ts";
import type { TuiOptions } from "#src/tui/options.ts";
import {
	COMPACT_FOOTER_FIXED_LINES,
	COMPACT_FOOTER_INPUT_ROW,
	FULL_FOOTER_FIXED_LINES,
	FULL_FOOTER_INPUT_ROW,
} from "#src/tui/runtime/constants.ts";
import type { TuiState } from "#src/tui/runtime/types.ts";

/**
 * 终端几何与页脚高度。
 *
 * 光标定位、点击命中、主区域高度与整帧绘制必须共用同一份算法：任何一处自己再算一遍，
 * 页脚结构调整后就会各错各的。
 */

/** 当前终端宽度;宽度变化是重建视图与重排面板的统一触发条件。 */
export function terminalWidth(state: TuiState): number {
	return Math.max(1, state.stdout.columns ?? DEFAULT_COLUMNS);
}

export function terminalRows(state: TuiState): number {
	return terminalHeight(state.stdout);
}

/** 当前是否处于 Plan 模式；只读闸门在宿主，界面只负责显示与命令。 */
export function planning(options: TuiOptions): boolean {
	return options.planMode?.current() === true;
}

/** 审批面板的高度随详情展开变化；其余面板高度固定。 */
function approvalHeight(state: TuiState): number {
	const prompt = state.approvalPrompt;
	if (prompt === undefined) return 0;
	return approvalPanelHeight(prompt, state.approvalExpanded, terminalWidth(state), terminalRows(state));
}

/** 审批面板、选择面板占用的行数；没开面板为 0。 */
export function menuHeight(state: TuiState): number {
	if (state.approvalPrompt !== undefined) return approvalHeight(state);
	const limit = menuVisibleLimit(state);
	if (state.modelMenu !== undefined) return modelMenuHeight(state.modelMenu.items.length, limit);
	if (state.effortMenu !== undefined) return effortMenuHeight(limit);
	if (state.sessionMenu !== undefined) {
		return sessionMenuHeight(state.sessionMenu.items.length, limit);
	}
	if (state.commandMenu !== undefined) return commandMenuHeight(state.commandMenu.items.length, limit);
	if (state.fileMenu !== undefined) return fileMenuHeight(state.fileMenu.items.length, limit);
	if (state.skillMenu !== undefined) return skillMenuHeight(state.skillMenu.items.length, limit);
	return 0;
}

/**
 * 小终端下菜单最多能显示几行。
 *
 * 菜单画在输入框上方，自身还有上下边框；终端高度不够时按可用行数收缩，
 * 否则整帧会从顶部裁掉，连菜单的选中项都可能看不到。
 */
export function menuVisibleLimit(state: TuiState): number {
	const rows = terminalRows(state);
	const inputLines = inputView(state.input, terminalWidth(state), state.inputCursor).lines.length;
	const available = rows - COMPACT_FOOTER_FIXED_LINES - inputLines - 2;
	return Math.max(1, Math.min(MENU_MAX_VISIBLE, available));
}

export function menuOpen(state: TuiState): boolean {
	return (
		state.approvalPrompt !== undefined ||
		state.modelMenu !== undefined ||
		state.effortMenu !== undefined ||
		state.sessionMenu !== undefined ||
		state.commandMenu !== undefined ||
		state.fileMenu !== undefined ||
		state.skillMenu !== undefined
	);
}

/** 抢输入焦点的面板:命令补全不抢(输入还在打字),模型/思考等级/会话面板是模态的。 */
export function modalMenuOpen(state: TuiState): boolean {
	return (
		state.modelMenu !== undefined ||
		state.effortMenu !== undefined ||
		state.sessionMenu !== undefined
	);
}

/** 整屏页与菜单一样把输入框让给内容：紧凑页脚、不画光标。 */
export function compactFooter(state: TuiState): boolean {
	return menuOpen(state) || state.openPage !== undefined;
}

export function footerHeight(state: TuiState, _options: TuiOptions): number {
	if (state.approvalPrompt !== undefined) return approvalHeight(state);
	// 信任页与整屏页一样独占画面：输入框与常驻信息都让给内容
	if (state.openPage !== undefined || state.trustPrompt !== undefined) return 0;
	const lines = inputView(state.input, terminalWidth(state), state.inputCursor).lines.length;
	if (!compactFooter(state)) {
		return FULL_FOOTER_FIXED_LINES + queueHeight(state.queued.length) + lines;
	}
	return COMPACT_FOOTER_FIXED_LINES + lines + menuHeight(state);
}

/**
 * 常驻任务面板的高度:无任务表、空表或已收尾为 0;收起缩为一行,其余头行加条目。
 * 审批卡是模态决定,打开时给卡片让位,保证动作行不被挤掉。
 */
export function todoPanelHeight(state: TuiState, options: TuiOptions): number {
	const todo = state.currentTodo;
	if (
		state.openPage !== undefined ||
		state.trustPrompt !== undefined ||
		state.approvalPrompt !== undefined ||
		planning(options) ||
		todo === undefined ||
		todo.items.length === 0 ||
		todoCardFinished(todo)
	) {
		return 0;
	}
	if (todo.collapsed === true) return 1;
	// 条目超上限时面板多出一行「… N more」，高度必须把它算进去，否则主区域多占一行、
	// 光标落到面板上、页脚最后一行被裁掉。
	const shown = Math.min(todo.items.length, TODO_PANEL_MAX_ITEMS);
	const overflow = todo.items.length > TODO_PANEL_MAX_ITEMS ? 1 : 0;
	return 1 + shown + overflow;
}

/** 页脚之外的主区域高度:对话流、整屏页与命中判定都用这一个数。 */
export function mainAreaHeight(state: TuiState, options: TuiOptions): number {
	return Math.max(0, terminalHeight(state.stdout) - footerHeight(state, options) - todoPanelHeight(state, options));
}

/**
 * 输入行首行在终端里的 1 基行号。
 *
 * 常驻任务面板夹在主区域与页脚之间,它占的行数同样要算进来——漏掉它,光标就落到
 * 面板最后一行上,看起来像凭空多出一根竖线。
 */
export function inputTopRow(state: TuiState, options: TuiOptions, mainHeight: number): number {
	const panel = todoPanelHeight(state, options);
	return compactFooter(state)
		? mainHeight + panel + menuHeight(state) + COMPACT_FOOTER_INPUT_ROW
		: mainHeight + panel + FULL_FOOTER_INPUT_ROW + queueHeight(state.queued.length);
}
