import { THINKING_LEVELS, type ThinkingLevel } from "#src/config/file.ts";
import { keepVisible, moveMenuSelection } from "#src/tui/panel/menu-panel.ts";
import type { CommandMenuItem, CommandMenuState } from "#src/tui/panel/command-menu.ts";
import type { EffortMenuState } from "#src/tui/panel/effort-menu.ts";
import type { FileMenuState } from "#src/tui/panel/file-menu.ts";
import { filterFiles, findAtToken, formatFileReference } from "#src/tui/panel/file-menu.ts";
import { filterSkills, findSkillToken, type SkillMenuState } from "#src/tui/panel/skill-menu.ts";
import { isImagePath } from "#src/tui/image.ts";
import type { ModelMenuItem, ModelMenuState } from "#src/tui/panel/model-menu.ts";
import type { SessionMenuItem, SessionMenuState } from "#src/tui/panel/session-menu.ts";
import { errorLine } from "#src/tui/render/status.ts";
import {
	FAILURE_ACTIONS,
	NO_MODELS,
	PANEL,
	STATUS,
	effortSet,
	failure,
	modelSwitched,
} from "#src/tui/copy.ts";
import { describeError } from "#src/shared/describe-error.ts";
import type { TranscriptLine } from "#src/tui/transcript.ts";
import { markTranscriptDirty } from "#src/tui/runtime/transcript-state.ts";
import { modalMenuOpen, menuVisibleLimit } from "#src/tui/runtime/geometry.ts";
import type { TuiHost, TuiState } from "#src/tui/runtime/types.ts";

/**
 * 输入框上方的选择面板。
 *
 * 模型、思考等级、会话三种面板是模态的，命令补全与文件补全只跟着输入过滤。五种面板互斥，
 * 移动、确认、补全与取消各只有一份实现，作用于当前打开的那一个；写回配置、切换会话这类
 * 差异点留在各自的 select 函数里，公共的滚动窗口规则在 panel 目录里。
 */

/** 六种互斥的选择面板；条目类型不同，公共状态都是一份 MenuListState。 */
type AnyMenuState =
	| CommandMenuState
	| EffortMenuState
	| FileMenuState
	| ModelMenuState
	| SessionMenuState
	| SkillMenuState;

/** 把光标移动 delta 并保证它落在可见窗口内；键盘移动首尾相接。 */
function moveCursor(
	menu: { cursor: number; scrollTop: number; hover?: number; pressed?: number },
	delta: number,
	count: number,
	maxVisible: number,
): void {
	moveMenuSelection(menu, delta, count, true, maxVisible);
	// 键盘接管后，指针位置与旧的高亮/按下状态不再对应
	menu.hover = undefined;
	menu.pressed = undefined;
}

/** 收起全部模态面板；各面板的确认与取消都先走这一步。 */
function closeAllMenus(host: TuiHost): void {
	host.state.modelMenu = undefined;
	host.state.effortMenu = undefined;
	host.state.sessionMenu = undefined;
	host.state.commandMenu = undefined;
}

/** 当前打开的选择面板；模态面板优先于行内补全。 */
function openMenu(state: TuiState): AnyMenuState | undefined {
	return (
		state.modelMenu ??
		state.effortMenu ??
		state.sessionMenu ??
		state.commandMenu ??
		state.fileMenu ??
		state.skillMenu
	);
}

export function openModelMenu(host: TuiHost): void {
	const source = host.options.modelMenu;
	if (source === undefined) return;

	closeAllMenus(host);
	const items = source.list();
	if (items.length === 0) {
		host.setInput("");
		host.state.turns.push({ prompt: "/model", response: [NO_MODELS] });
		markTranscriptDirty(host.state);
		host.state.hasInput = true;
		host.render();
		return;
	}

	const current = items.findIndex((item) => item.current);
	host.state.modelMenu = { items, cursor: current >= 0 ? current : 0, scrollTop: 0 };
	
	host.render();
}

/** 上下键移动当前打开面板的光标；五种面板共用这一份。 */
export function moveMenu(host: TuiHost, delta: number): void {
	const menu = openMenu(host.state);
	if (menu === undefined) return;
	moveCursor(menu, delta, menu.items.length, menuVisibleLimit(host.state));
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
			modelSwitched(`${item.provider}/${item.model}`, host.state.activeTurn !== undefined),
			...result.warnings.map((text) => ({ kind: "warning" as const, text })),
		];
	} catch (error) {
		response = [
			{
				kind: "error",
				text: failure(FAILURE_ACTIONS.modelSwitch, describeError(error)),
			},
		];
	}
	host.appendCommandTurn("/model", response);
}

/** 回车确认当前打开的模态面板；收起与清空输入只写一份，写回逻辑在各自的 select 里。 */
export function confirmMenu(host: TuiHost): void {
	const state = host.state;
	if (state.modelMenu !== undefined) {
		const item = state.modelMenu.items[state.modelMenu.cursor];
		closeAllMenus(host);
		host.setInput("");
		if (item !== undefined) selectModel(host, item);
		host.render();
		return;
	}
	if (state.effortMenu !== undefined) {
		const level = THINKING_LEVELS[state.effortMenu.cursor];
		closeAllMenus(host);
		host.setInput("");
		if (level !== undefined) selectEffort(host, level);
		host.render();
		return;
	}
	if (state.sessionMenu !== undefined) {
		const menu = state.sessionMenu;
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
}

/**
 * Tab 在最后一级面板只把选中项补进输入框，不执行；要生效仍按回车。
 */
export function completeMenu(host: TuiHost): void {
	const state = host.state;
	if (state.modelMenu !== undefined) {
		const item = state.modelMenu.items[state.modelMenu.cursor];
		if (item === undefined) return;
		closeAllMenus(host);
		host.setInput(`/model ${item.provider}/${item.model}`);
	} else if (state.effortMenu !== undefined) {
		const level = THINKING_LEVELS[state.effortMenu.cursor];
		if (level === undefined) return;
		closeAllMenus(host);
		host.setInput(`/effort ${level}`);
	} else if (state.sessionMenu !== undefined) {
		const menu = state.sessionMenu;
		const item = menu.items[menu.cursor];
		if (item === undefined) return;
		closeAllMenus(host);
		host.setInput(`/session ${item.id}`);
	} else {
		return;
	}
	// 补进输入框之后使用者要按回车确认，焦点必须在输入框上，否则那一下只会被当成抢焦点
	host.state.focused = true;
	host.render();
}

/** Esc 收起模态面板并清空输入；三种模态面板在这一步没有差异。 */
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
		items: THINKING_LEVELS,
		current,
		cursor,
		scrollTop: keepVisible(0, cursor, THINKING_LEVELS.length),
	};
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
			effortSet(level, host.state.activeTurn !== undefined),
		];
	} catch (error) {
		response = [
			{
				kind: "error",
				text: failure(FAILURE_ACTIONS.effortSet, describeError(error)),
			},
		];
	}
	host.appendCommandTurn("/effort", response);
}

export function openSessionMenu(host: TuiHost): void {
	const source = host.options.sessionMenu;
	if (source === undefined) return;
	openSessionKindMenu(host, () => source.list());
}

/** 打开会话面板；列清单失败或为空时不弹面板，写一条说明回合，输入框交还给使用者。 */
function openSessionKindMenu(host: TuiHost, list: () => readonly SessionMenuItem[]): void {
	closeAllMenus(host);
	let items: readonly SessionMenuItem[];
	try {
		items = list();
	} catch (error) {
		host.setInput("");
		host.state.follow = true;
		host.appendCommandTurn("/session", [
			{ kind: "error", text: failure(FAILURE_ACTIONS.sessionsList, describeError(error)) },
		]);
		return;
	}
	if (items.length === 0) {
		host.setInput("");
		host.state.follow = true;
		host.appendCommandTurn("/session", [PANEL.noSessions]);
		return;
	}

	const current = items.findIndex((item) => item.current);
	host.state.sessionMenu = { items, cursor: current >= 0 ? current : 0, scrollTop: 0 };
	host.render();
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
	// 这里按去掉尾随空格后的内容判断：快速连按空格时终端会把多个空格合并成一块，
	// 只认「恰好一个空格」会让 /session  + 空格 既不打开面板、也把补全菜单收掉。
	if (state.input.startsWith("/") && state.input.endsWith(" ")) {
		const trimmed = state.input.trimEnd();
		if (!trimmed.slice(1).includes(" ")) {
			const name = trimmed.slice(1).toLowerCase();
			const command = host.commands().find((item) => item.name === name);
			state.commandMenu = undefined;
			if (command !== undefined) {
				if (name === "model") openModelMenu(host);
				else if (name === "effort") openEffortMenu(host);
				else if (name === "session") openSessionMenu(host);
			}
			return;
		}
	}

	if (state.input.startsWith("/") && !state.input.slice(1).includes(" ")) {
		const query = state.input.slice(1).toLowerCase();
		const visible = (command: CommandMenuItem): boolean =>
			// 隐藏命令只在完整输入命令名时出现，避免塞满补全列表
			command.hidden !== true || command.name.toLowerCase() === query;
		// 命令名前缀是精确意图：只要有一个前缀命中，就不再混入描述命中。
		// 否则敲 /e 时几乎每条英文说明都含 e，整张命令表都会留在列表里。
		const prefixMatches = host.commands().filter(
			(command) => visible(command) && command.name.toLowerCase().startsWith(query),
		);
		const descriptionMatches = host.commands().filter(
			(command) =>
				visible(command) &&
				!command.name.toLowerCase().startsWith(query) &&
				command.description.toLowerCase().includes(query),
		);
		const items = prefixMatches.length > 0 ? prefixMatches : descriptionMatches;
		if (items.length > 0) {
			const exact = items.findIndex((item) => item.name.toLowerCase() === query);
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

		// 没匹配也保留面板：直接收掉会让人以为补全坏了
		state.commandMenu = { items: [], cursor: 0, scrollTop: 0 };
		return;
	}

	state.commandMenu = undefined;
}

/**
 * 命令补全项：把选中命令补进输入框。
 *
 * Tab 补全时顺带打开有二级面板的命令（模型、思考等级、会话），使用者不必再按一次
 * 回车；鼠标点击只回填、不执行，避免点一下就把面板弹出来。其余命令补完后仍由回车执行。
 */
export function completeCommandMenu(host: TuiHost, openSubmenu = false): void {
	const state = host.state;
	const menu = state.commandMenu;
	const chosen = menu?.items[menu.cursor];
	if (chosen === undefined) return;

	host.setInput(`/${chosen.name} `);
	state.commandMenu = undefined;
	if (openSubmenu) {
		if (chosen.name === "model" || chosen.name === "effort") {
			const source = chosen.name === "model" ? host.options.modelMenu : host.options.effortMenu;
			if (source === undefined) {
				// 补全成功但二级面板不可用：不解释的话看起来像按键没反应
				host.resetStatusMeta();
				host.setStatus(STATUS.configurationInvalid, "notice");
				host.scheduleStatusClear();
			} else if (chosen.name === "model") {
				openModelMenu(host);
			} else {
				openEffortMenu(host);
			}
		} else if (chosen.name === "session") {
			if (host.options.sessionMenu === undefined) {
				host.resetStatusMeta();
				host.setStatus(STATUS.sessionStorageUnavailable, "notice");
				host.scheduleStatusClear();
			} else {
				openSessionMenu(host);
			}
		}
	}
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
			host.setStatus(failure(FAILURE_ACTIONS.listFiles, errorLine(error)), "error");
			host.scheduleStatusClear();
		}
	}

	const items = filterFiles(state.fileFiles, token.query);
	if (items.length === 0) {
		// 索引留着：继续输入出现匹配时不必再扫一遍；面板保留，显示无匹配而不是消失
		state.fileMenu = { items: [], token, cursor: 0, scrollTop: 0 };
		return;
	}

	const previous = state.fileMenu?.items[state.fileMenu.cursor];
	const kept = previous === undefined ? -1 : items.indexOf(previous);
	const cursor = kept >= 0 ? kept : 0;
	state.fileMenu = { items, token, cursor, scrollTop: keepVisible(0, cursor, items.length) };
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

/** 收起 $ 技能面板；dismissed 表示使用者主动按了 Esc，输入不变就不再自动弹回来。 */
export function closeSkillMenu(host: TuiHost, dismissed = false): void {
	host.state.skillMenu = undefined;
	host.state.skillEntries = undefined;
	host.state.skillIndexStart = undefined;
	if (dismissed) host.state.skillMenuDismissed = true;
}

/**
 * 按光标所在的 `$` 片段刷新技能面板。
 *
 * 与文件面板同一套节奏：每次重新打开都重扫清单，同一次补全里只过滤缓存。两个行内面板互斥——
 * 调用顺序是命令面板、文件面板、技能面板，后者看到前者开着就收起自己，同一时间只开一个。
 */
export function updateSkillMenu(host: TuiHost): void {
	const state = host.state;
	const source = host.options.skills;
	if (source === undefined) {
		closeSkillMenu(host);
		return;
	}
	if (modalMenuOpen(state) || state.commandMenu !== undefined || state.fileMenu !== undefined) {
		closeSkillMenu(host);
		return;
	}
	if (state.skillMenuDismissed) {
		state.skillMenu = undefined;
		return;
	}

	const token = findSkillToken(state.input, state.inputCursor);
	if (token === undefined) {
		closeSkillMenu(host);
		return;
	}

	if (state.skillEntries === undefined || state.skillIndexStart !== token.start) {
		state.skillIndexStart = token.start;
		state.skillEntries = source.list().map((skill) => ({
			name: skill.name,
			description: skill.description,
			scope: skill.scope,
		}));
	}
	state.skillMenu = {
		items: filterSkills(state.skillEntries, token.query),
		token,
		cursor: 0,
		scrollTop: 0,
	};
}

/** 把选中的技能补全成 `$name` 写回输入框；只补名字，正文由模型按提示词自己去读。 */
export function insertSkillReference(host: TuiHost): void {
	const menu = host.state.skillMenu;
	if (menu === undefined) return;
	const skill = menu.items[menu.cursor];
	if (skill === undefined) return;
	const state = host.state;
	const token = menu.token;

	const reference = `$${skill.name}`;
	const next = state.input.slice(0, token.start) + reference + " " + state.input.slice(token.end);
	host.setInput(next, token.start + reference.length + 1);
	closeSkillMenu(host);
	updateCommandMenu(host);
	host.render();
}

