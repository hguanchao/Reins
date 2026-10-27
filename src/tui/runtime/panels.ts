import { THINKING_LEVELS, type ThinkingLevel } from "../../config/file.ts";
import { TURN_SAFE_COMMANDS } from "../commands.ts";
import { keepVisible } from "../panel/menu-panel.ts";
import type { ModelMenuItem } from "../panel/model-menu.ts";
import type { SessionMenuItem } from "../panel/session-menu.ts";
import { errorLine } from "../render/status.ts";
import { describeError } from "../../shared/describe-error.ts";
import type { TranscriptLine } from "../transcript.ts";
import { filterFiles, findAtToken, formatFileReference } from "../panel/file-menu.ts";
import { isImagePath } from "../image.ts";
import { markTranscriptDirty } from "./transcript-state.ts";
import { modalMenuOpen } from "./geometry.ts";
import type { TuiHost } from "./types.ts";

/**
 * 输入框上方的选择面板。
 *
 * 模型、思考等级、会话三种面板是模态的，命令补全与文件补全只跟着输入过滤。
 * 开关、移动、确认与取消都按面板分开写，公共的滚动窗口规则在 panel 目录里。
 */

/** 把光标移动 delta 并保证它落在可见窗口内；窗口最多 8 行。 */
function moveCursor(menu: { cursor: number; scrollTop: number }, delta: number, count: number): void {
	menu.cursor = Math.min(count - 1, Math.max(0, menu.cursor + delta));
	menu.scrollTop = keepVisible(menu.scrollTop, menu.cursor, count);
}

/** 收起全部模态面板；各面板的确认与取消都先走这一步。 */
function closeAllMenus(host: TuiHost): void {
	host.state.modelMenu = undefined;
	host.state.effortMenu = undefined;
	host.state.sessionMenu = undefined;
	host.state.commandMenu = undefined;
}

export function openModelMenu(host: TuiHost): void {
	const source = host.options.modelMenu;
	if (source === undefined) return;

	closeAllMenus(host);
	const items = source.list();
	if (items.length === 0) {
		host.setInput("");
		host.state.turns.push({ prompt: "/model", response: ["No models are available."] });
		markTranscriptDirty(host.state);
		host.state.hasInput = true;
		host.render();
		return;
	}

	const current = items.findIndex((item) => item.current);
	host.state.modelMenu = { items, cursor: current >= 0 ? current : 0, scrollTop: 0 };
	
	host.render();
}

export function moveMenu(host: TuiHost, delta: number): void {
	const menu = host.state.modelMenu;
	if (menu === undefined) return;
	moveCursor(menu, delta, menu.items.length);
	host.render();
}

/** 写回模型选择；菜单回车确认与 `/model <provider>/<model>` 共用同一条路径。 */
export function selectModel(host: TuiHost, item: ModelMenuItem): void {
	const source = host.options.modelMenu;
	if (source === undefined) return;

	let response: TranscriptLine[];
	try {
		const result = source.select(item);
		host.state.ready = result.ready;
		host.state.activeWarning = result.warning;
		response = [
			`Model switched to ${item.provider}/${item.model}${host.state.activeTurn === undefined ? "." : " (from the next turn)."}`,
			...result.warnings.map((text) => ({ kind: "warning" as const, text })),
		];
	} catch (error) {
		response = [
			{
				kind: "error",
				text: `Error: Failed to switch model: ${describeError(error)}`,
			},
		];
	}
	host.appendCommandTurn("/model", response);
}

export function confirmMenu(host: TuiHost): void {
	const menu = host.state.modelMenu;
	if (menu === undefined) return;

	const item = menu.items[menu.cursor];
	closeAllMenus(host);
	host.setInput("");

	if (item !== undefined) selectModel(host, item);
	host.render();
}

/** Tab 在最后一级面板只把选中项补进输入框，不执行；要切换仍按回车。 */
export function completeModelMenu(host: TuiHost): void {
	const menu = host.state.modelMenu;
	const item = menu?.items[menu.cursor];
	if (item === undefined) return;

	closeAllMenus(host);
	host.setInput(`/model ${item.provider}/${item.model}`);
	// 补进输入框之后使用者要按回车确认，焦点必须在输入框上，否则那一下只会被当成抢焦点
	host.state.focused = true;
	host.render();
}

export function cancelMenu(host: TuiHost): void {
	closeAllMenus(host);
	host.setInput("");
	host.render();
}

export function openEffortMenu(host: TuiHost): void {
	const source = host.options.effortMenu;
	if (source === undefined) return;

	const current = source.current();
	const cursor = Math.max(0, THINKING_LEVELS.indexOf(current));
	closeAllMenus(host);
	host.state.effortMenu = {
		current,
		cursor,
		scrollTop: keepVisible(0, cursor, THINKING_LEVELS.length),
	};
	host.render();
}

export function moveEffortMenu(host: TuiHost, delta: number): void {
	const menu = host.state.effortMenu;
	if (menu === undefined) return;
	moveCursor(menu, delta, THINKING_LEVELS.length);
	host.render();
}

/** 写回思考等级；菜单回车确认与 `/effort <level>` 共用同一条路径。 */
export function selectEffort(host: TuiHost, level: ThinkingLevel): void {
	const source = host.options.effortMenu;
	if (source === undefined) return;

	let response: TranscriptLine[];
	try {
		source.select(level);
		response = [
			`Effort set to ${level}${host.state.activeTurn === undefined ? "." : " (from the next turn)."}`,
		];
	} catch (error) {
		response = [
			{
				kind: "error",
				text: `Error: Failed to set effort: ${describeError(error)}`,
			},
		];
	}
	host.appendCommandTurn("/effort", response);
}

export function confirmEffortMenu(host: TuiHost): void {
	const menu = host.state.effortMenu;
	if (menu === undefined) return;

	const level = THINKING_LEVELS[menu.cursor];
	closeAllMenus(host);
	host.setInput("");

	if (level !== undefined) selectEffort(host, level);
	host.render();
}

/** Tab 在最后一级面板只把选中项补进输入框，不执行；要写回仍按回车。 */
export function completeEffortMenu(host: TuiHost): void {
	const menu = host.state.effortMenu;
	const level = menu === undefined ? undefined : THINKING_LEVELS[menu.cursor];
	if (level === undefined) return;

	closeAllMenus(host);
	host.setInput(`/effort ${level}`);
	host.state.focused = true;
	host.render();
}

export function cancelEffortMenu(host: TuiHost): void {
	closeAllMenus(host);
	host.setInput("");
	host.render();
}

export function openSessionMenu(host: TuiHost): void {
	const source = host.options.sessionMenu;
	if (source === undefined) return;

	closeAllMenus(host);
	let items: readonly SessionMenuItem[];
	try {
		items = source.list();
	} catch (error) {
		host.setInput("");
		host.state.follow = true;
		const message = describeError(error);
		host.appendCommandTurn("/session", [
			{ kind: "error", text: `Error: Failed to list sessions: ${message}` },
		]);
		return;
	}
	if (items.length === 0) {
		host.setInput("");
		host.state.follow = true;
		host.appendCommandTurn("/session", ["No sessions in this project yet."]);
		return;
	}

	const current = items.findIndex((item) => item.current);
	host.state.sessionMenu = { items, cursor: current >= 0 ? current : 0, scrollTop: 0 };
	
	host.render();
}

export function moveSessionMenu(host: TuiHost, delta: number): void {
	const menu = host.state.sessionMenu;
	if (menu === undefined) return;
	moveCursor(menu, delta, menu.items.length);
	host.render();
}

export function confirmSessionMenu(host: TuiHost): void {
	const menu = host.state.sessionMenu;
	if (menu === undefined) return;

	const item = menu.items[menu.cursor];
	closeAllMenus(host);
	host.setInput("");

	// 选中的就是当前会话：关掉面板即可，不必重放一遍历史
	if (item === undefined || item.current) {
		host.render();
		return;
	}
	host.switchSession(item.id);
}

/** 会话菜单里按 f：从选中会话的末尾分叉，并切到新会话。 */
export function forkSelectedSession(host: TuiHost): void {
	const menu = host.state.sessionMenu;
	if (menu === undefined) return;

	const item = menu.items[menu.cursor];
	closeAllMenus(host);
	host.setInput("");
	if (item === undefined) {
		host.render();
		return;
	}
	host.switchSession(item.id, "fork");
}

/** Tab 在最后一级面板只补全，不切换；要切换仍按回车。 */
export function completeSessionMenu(host: TuiHost): void {
	const menu = host.state.sessionMenu;
	const item = menu?.items[menu.cursor];
	if (item === undefined) return;

	closeAllMenus(host);
	host.setInput(`/session ${item.id}`);
	host.state.focused = true;
	host.render();
}

export function cancelSessionMenu(host: TuiHost): void {
	closeAllMenus(host);
	host.setInput("");
	host.render();
}

/** 输入变化后重算命令补全列表；只匹配斜杠后不含空格的命令名。 */
export function updateCommandMenu(host: TuiHost): void {
	const state = host.state;
	if (modalMenuOpen(state)) return;
	// Esc 关掉之后不再自动弹出：输入一变会重置这个标记，那时才会重新计算
	if (state.commandMenuDismissed) {
		state.commandMenu = undefined;
		return;
	}

	// 敲完命令名再按空格：有二级选择面板的直接打开它，没有的就把补全面板收掉。
	// 这里只认「命令名 + 空格」本身，后面已经打了参数就不再插手
	if (state.input.startsWith("/") && state.input.endsWith(" ") && !state.input.slice(1, -1).includes(" ")) {
		const name = state.input.slice(1, -1).toLowerCase();
		const command = host.commands().find((item) => item.name === name);
		state.commandMenu = undefined;
		if (command !== undefined) {
			if (name === "model") openModelMenu(host);
			else if (name === "effort") openEffortMenu(host);
			else if (name === "session") openSessionMenu(host);
		}
		return;
	}

	if (state.input.startsWith("/") && !state.input.slice(1).includes(" ")) {
		const query = state.input.slice(1).toLowerCase();
		const items = host.commands().filter(
			(command) =>
				command.name.toLowerCase().startsWith(query) ||
				command.description.toLowerCase().includes(query),
		);
		if (items.length > 0) {
			// 输入完整命令名时，光标落到这条命令上：描述里含同一个词的其他命令
			// 也匹配得上，不这样做，敲完 /session 回车会先执行排在前面的 /model
			const exact = items.findIndex((item) => item.name === query);
			const previous = state.commandMenu?.items[state.commandMenu.cursor]?.name;
			const cursor =
				exact >= 0
					? exact
					: previous === undefined
						? 0
						: Math.max(0, items.findIndex((item) => item.name === previous));
			state.commandMenu = {
				items,
				cursor,
				scrollTop: keepVisible(0, cursor, items.length),
			};
			return;
		}
	}

	state.commandMenu = undefined;
}

/**
 * Tab 或点击命令补全项：把选中命令补进输入框，不执行。
 *
 * 有二级选择面板的命令直接打开面板，输入框保留命令名；其余只补命令名与空格。
 * 点击是明确的选中动作，补完就收起补全面板；Tab 保留继续浏览的语义。执行统一交给回车；
 * 一轮进行中只放行不碰对话的命令。
 */
export function completeCommandMenu(host: TuiHost, dismiss = false): void {
	const state = host.state;
	const menu = state.commandMenu;
	const chosen = menu?.items[menu.cursor];
	if (chosen === undefined) return;

	const opensPanel =
		(chosen.name === "model" && host.options.modelMenu !== undefined) ||
		(chosen.name === "effort" && host.options.effortMenu !== undefined) ||
		(chosen.name === "session" && host.options.sessionMenu !== undefined);
	if (opensPanel && (state.activeTurn === undefined || TURN_SAFE_COMMANDS.has(chosen.name))) {
		host.executeCommand(chosen);
		return;
	}
	host.setInput(`/${chosen.name} `);
	if (dismiss) state.commandMenu = undefined;
	host.render();
}

export function moveCommandMenu(host: TuiHost, delta: number): void {
	const menu = host.state.commandMenu;
	if (menu === undefined) return;
	moveCursor(menu, delta, menu.items.length);
	host.render();
}

/** 收起 @ 面板；dismissed 表示使用者主动按了 Esc，输入不变就不再弹回来。 */
export function closeFileMenu(host: TuiHost, dismissed = false): void {
	host.state.fileMenu = undefined;
	host.state.fileFiles = undefined;
	host.state.fileIndexStart = undefined;
	if (dismissed) host.state.fileMenuDismissed = true;
}

/**
 * 按光标所在的 @ 片段刷新文件面板。
 *
 * 每次从一个片段重新打开时重扫文件清单（使用者可能刚让模型建了新文件）；同一次补全里
 * 只过滤缓存，避免每敲一个字都遍历一遍工作区。
 */
export function updateFileMenu(host: TuiHost): void {
	const state = host.state;
	const source = host.options.files;
	if (source === undefined) {
		closeFileMenu(host);
		return;
	}
	if (modalMenuOpen(state) || state.commandMenu !== undefined || state.input.startsWith("/")) {
		closeFileMenu(host);
		return;
	}
	if (state.fileMenuDismissed) {
		state.fileMenu = undefined;
		return;
	}

	const token = findAtToken(state.input, state.inputCursor);
	if (token === undefined) {
		closeFileMenu(host);
		return;
	}

	if (state.fileFiles === undefined || state.fileIndexStart !== token.start) {
		state.fileIndexStart = token.start;
		try {
			state.fileFiles = source.list().filter((path) => !/[\u0000-\u001f\u007f]/.test(path));
		} catch (error) {
			state.fileFiles = [];
			host.setStatus(`Could not list files: ${errorLine(error)}`, "error");
			host.scheduleStatusClear();
		}
	}

	const items = filterFiles(state.fileFiles, token.query);
	if (items.length === 0) {
		// 索引留着：继续输入出现匹配时不必再扫一遍
		state.fileMenu = undefined;
		return;
	}

	const previous = state.fileMenu?.items[state.fileMenu.cursor];
	const kept = previous === undefined ? -1 : items.indexOf(previous);
	const cursor = kept >= 0 ? kept : 0;
	state.fileMenu = { items, token, cursor, scrollTop: keepVisible(0, cursor, items.length) };
}

export function moveFileMenu(host: TuiHost, delta: number): void {
	const menu = host.state.fileMenu;
	if (menu === undefined) return;
	moveCursor(menu, delta, menu.items.length);
	host.render();
}

/**
 * 选中 @ 项：文本文件写回 `@相对路径`；图片读进来后在原位置插入正文标记。
 *
 * 图片路径需要附件模块配合，所以留给调用方通过回填回调插入。
 */
export function insertFileReference(
	host: TuiHost,
	attachImage: (path: string, at: number) => void,
): void {
	const menu = host.state.fileMenu;
	if (menu === undefined) return;
	const path = menu.items[menu.cursor];
	if (path === undefined) return;
	const token = menu.token;
	const state = host.state;

	if (isImagePath(path) && host.options.images !== undefined) {
		// 先把 @片段去掉，图片读完后在同一位置插入标记
		const next = state.input.slice(0, token.start) + state.input.slice(token.end);
		host.setInput(next, token.start);
		closeFileMenu(host);
		updateCommandMenu(host);
		attachImage(path, token.start);
		return;
	}

	const reference = formatFileReference(path);
	const next = state.input.slice(0, token.start) + reference + " " + state.input.slice(token.end);
	host.setInput(next, token.start + reference.length + 1);
	closeFileMenu(host);
	updateCommandMenu(host);
	host.render();
}

