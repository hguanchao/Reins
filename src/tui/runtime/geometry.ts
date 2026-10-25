import { inputView, queueHeight } from "../view/footer.ts";
import { APPROVAL_PANEL_HEIGHT } from "../panel/approval-panel.ts";
import { commandMenuHeight } from "../panel/command-menu.ts";
import { effortMenuHeight } from "../panel/effort-menu.ts";
import { fileMenuHeight } from "../panel/file-menu.ts";
import { modelMenuHeight } from "../panel/model-menu.ts";
import { sessionMenuHeight } from "../panel/session-menu.ts";
import { DEFAULT_COLUMNS, terminalHeight } from "../terminal.ts";
import { todoCardFinished, TODO_PANEL_MAX_ITEMS } from "../view/todo-card.ts";
import type { JobView } from "../page/job.ts";
import type { TuiOptions } from "../options.ts";
import {
	COMPACT_FOOTER_FIXED_LINES,
	COMPACT_FOOTER_INPUT_ROW,
	FULL_FOOTER_FIXED_LINES,
	FULL_FOOTER_INPUT_ROW,
} from "./constants.ts";
import type { TuiState } from "./types.ts";

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

/** 审批面板、选择面板占用的行数；没开面板为 0。 */
export function menuHeight(state: TuiState, options: TuiOptions): number {
	if (state.approvalPrompt !== undefined) return APPROVAL_PANEL_HEIGHT;
	if (state.modelMenu !== undefined) return modelMenuHeight(state.modelMenu.items.length);
	if (state.effortMenu !== undefined) return effortMenuHeight();
	if (state.sessionMenu !== undefined) {
		return sessionMenuHeight(state.sessionMenu.items.length, options.sessionMenu?.fork !== undefined);
	}
	if (state.commandMenu !== undefined) return commandMenuHeight(state.commandMenu.items.length);
	if (state.fileMenu !== undefined) return fileMenuHeight(state.fileMenu.items.length);
	return 0;
}

export function menuOpen(state: TuiState): boolean {
	return (
		state.approvalPrompt !== undefined ||
		state.modelMenu !== undefined ||
		state.effortMenu !== undefined ||
		state.sessionMenu !== undefined ||
		state.commandMenu !== undefined ||
		state.fileMenu !== undefined
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

export function footerHeight(state: TuiState, options: TuiOptions): number {
	if (state.approvalPrompt !== undefined) return APPROVAL_PANEL_HEIGHT;
	// 整屏页不保留输入框与常驻信息
	if (state.openPage !== undefined) return 0;
	const lines = inputView(state.input, terminalWidth(state), state.inputCursor).lines.length;
	if (!compactFooter(state)) {
		return FULL_FOOTER_FIXED_LINES + queueHeight(state.queued.length) + lines;
	}
	return COMPACT_FOOTER_FIXED_LINES + lines + menuHeight(state, options);
}

/**
 * 常驻任务面板的高度:无任务表、空表或已收尾为 0;收起缩为一行,其余头行加条目。
 * 高度只在 todo 调用与收展切换时变化(低频),主区域随之重排。
 */
export function todoPanelHeight(state: TuiState, options: TuiOptions): number {
	const todo = state.currentTodo;
	if (
		state.openPage !== undefined ||
		planning(options) ||
		todo === undefined ||
		todo.items.length === 0 ||
		todoCardFinished(todo)
	) {
		return 0;
	}
	if (todo.collapsed === true) return 1;
	return 1 + Math.min(todo.items.length, TODO_PANEL_MAX_ITEMS);
}

/** 正在运行的作业；页脚上方的 Jobs bar 与计时器都只认它们。 */
export function runningJobs(options: TuiOptions): readonly JobView[] {
	return options.jobs?.list().filter((job) => job.status === "running") ?? [];
}

/** Jobs bar 只占一行；模态页与菜单打开时让位给内容。 */
export function jobBarHeight(state: TuiState, options: TuiOptions): number {
	return runningJobs(options).length > 0 &&
		state.openPage === undefined &&
		state.approvalPrompt === undefined &&
		!menuOpen(state)
		? 1
		: 0;
}

/** 页脚之外的主区域高度:对话流、整屏页与命中判定都用这一个数。 */
export function mainAreaHeight(state: TuiState, options: TuiOptions): number {
	return Math.max(
		0,
		terminalHeight(state.stdout) -
			footerHeight(state, options) -
			todoPanelHeight(state, options) -
			jobBarHeight(state, options),
	);
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
		? mainHeight + panel + menuHeight(state, options) + COMPACT_FOOTER_INPUT_ROW
		: mainHeight +
				panel +
				jobBarHeight(state, options) +
				FULL_FOOTER_INPUT_ROW +
				queueHeight(state.queued.length);
}
