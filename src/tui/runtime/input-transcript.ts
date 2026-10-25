import { TURN_SAFE_COMMANDS } from "../commands.ts";
import { inputView } from "../view/footer.ts";
import { imageMarker } from "../../image/attachment.ts";
import { MOUSE_BUTTON_MASK, MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, editInput, historyKey, menuIndexAtRow, menuKey, moveInputVertical, queuedEditKey, scrollKey, stripMouseEvents } from "../input.ts";
import type { MouseInput } from "../input.ts";
import { scrollButtonHit, scrollButtonPlacement } from "../view/scroll-button.ts";
import { ABORTING } from "../render/status.ts";
import { FOCUS_IN, FOCUS_OUT } from "../terminal.ts";
import { scrollTopForRow, toggleLastExpandable, toggleLastToolResult } from "../transcript.ts";
import { menuPanelTop } from "./approval.ts";
import { DOUBLE_CLICK_MS, WHEEL_STEP } from "./constants.ts";
import { markTranscriptDirty } from "./transcript-state.ts";
import type { InputDeps } from "./input.ts";
import { handleMenuMouse } from "./input-menus.ts";
import type { TuiHost } from "./types.ts";

export function handleTranscriptInput(
	host: TuiHost,
	deps: InputDeps,
	text: string,
	mouseOf: () => readonly MouseInput[],
): void {
	const state = host.state;
	const width = host.terminalWidth();
	const mainHeight = host.mainAreaHeight();
	const beforeScroll = state.scrollTop;
	const withoutMouse = stripMouseEvents(text);
	let focusChanged = false;
	let hoverChanged = false;
	let wheelSteps = 0;
	let dragRow: number | undefined;
	/** 置底按钮；命中判定与悬停都用同一份位置，保证画在哪里就能点在哪里。 */
	const bottomButton = host.menuOpen() ? undefined : scrollButtonPlacement(width, mainHeight);
	/** 按钮此刻是否真的画着：没画出来的位置不该被点中，也不该响应悬停。 */
	const buttonShown = bottomButton !== undefined && state.scrollTop < host.maxScroll();

	const lastIn = withoutMouse.lastIndexOf(FOCUS_IN);
	const lastOut = withoutMouse.lastIndexOf(FOCUS_OUT);
	if (lastIn >= 0 || lastOut >= 0) {
		const next = lastIn > lastOut;
		if (next !== state.focused) {
			state.focused = next;
			focusChanged = true;
		}
		if (!next) state.draggingScrollbar = false;
	}

	for (const event of mouseOf()) {
		const left = (event.button & MOUSE_BUTTON_MASK) === 0;
		const motion = event.button >= 32 && event.button < 64;
		// 低两位是 3 表示没有按键：1003 模式下这类事件只是指针在移动，也就是悬停
		const hover = motion && (event.button & MOUSE_BUTTON_MASK) === 3;

		if (hover) {
			const over = buttonShown && scrollButtonHit(bottomButton, event.row, event.column);
			if (over !== state.buttonHovered) {
				state.buttonHovered = over;
				hoverChanged = true;
			}
			continue;
		}

		if (event.press && event.button === MOUSE_WHEEL_UP) {
			wheelSteps -= 1;
		} else if (event.press && event.button === MOUSE_WHEEL_DOWN) {
			wheelSteps += 1;
		} else if (event.press && left && !motion) {
			// 置底按钮盖在对话流上，命中就回到底部并恢复跟随，不再往下走双击与聚焦判断
			if (buttonShown && scrollButtonHit(bottomButton, event.row, event.column)) {
				state.scrollTop = host.maxScroll();
				state.follow = true;
				state.draggingScrollbar = false;
				state.lastClick = undefined;
				deps.render();
				return;
			}

			const now = Date.now();
			const doubleClick =
				state.lastClick !== undefined &&
				now - state.lastClick.at <= DOUBLE_CLICK_MS &&
				state.lastClick.row === event.row &&
				state.lastClick.column === event.column;
			state.lastClick = { at: now, row: event.row, column: event.column };

			// 双击思考标题、工具组、任务卡或子代理组，展开或收起
			if (doubleClick && host.toggleTranscriptAt(event.row, event.column, mainHeight, width)) {
				return;
			}

			// 常驻面板头行:双击收起/展开条目。面板在对话流外面,行号要按自己的位置算
			if (
				doubleClick &&
				state.currentTodo !== undefined &&
				host.todoPanelHeight() > 0 &&
				event.row === mainHeight + 1 &&
				event.column < width - 1
			) {
				state.currentTodo.collapsed = state.currentTodo.collapsed !== true;
				state.lastClick = undefined;
				deps.render();
				return;
			}

			const inputLineTotal = inputView(state.input, width, state.inputCursor).lines.length;
			const inputTop = host.inputTopRow(mainHeight);
			const insideInput = event.row >= inputTop && event.row < inputTop + inputLineTotal;
			if (insideInput !== state.focused) {
				state.focused = insideInput;
				focusChanged = true;
			}
			if (!insideInput && event.column === width && event.row <= mainHeight && state.turns.length > 0) {
				state.draggingScrollbar = true;
				dragRow = event.row;
			} else {
				state.draggingScrollbar = false;
			}
		} else if (event.press && left && motion) {
			if (state.draggingScrollbar) dragRow = event.row;
		} else if (!event.press) {
			state.draggingScrollbar = false;
		}
	}

	if (wheelSteps !== 0) {
		const limit = host.maxScroll();
		state.scrollTop = Math.min(limit, Math.max(0, state.scrollTop + wheelSteps * WHEEL_STEP));
		state.follow = state.scrollTop >= limit;
	}
	if (dragRow !== undefined) {
		const limit = host.maxScroll();
		state.scrollTop = scrollTopForRow(dragRow, mainHeight, limit);
		state.follow = state.scrollTop >= limit;
	}
	const scrollChanged = state.scrollTop !== beforeScroll;

	if (state.commandMenu !== undefined) {
		// 命令补全面板不拦截文字输入，只接管上下键、Esc 与鼠标
		const commandPanelTop = menuPanelTop(state, host.options);
		const menu = state.commandMenu;
		if (
			handleMenuMouse(
				mouseOf(),
				{
					hitItem: (row) =>
						menuIndexAtRow(row, commandPanelTop, menu.items.length, menu.scrollTop, menu.cursor),
					cursor: () => menu.cursor,
					select: (index) => {
						menu.cursor = index;
						menu.scrollTop = Math.max(0, Math.min(index, menu.items.length - 1));
					},
					move: (delta) => host.moveCommandMenu(delta),
					confirm: () => {
						// 点击即选中并执行，与回车一致：有二级面板的命令点开面板，其余直接执行
						const chosen = menu.items[menu.cursor];
						if (chosen === undefined) return;
						if (state.activeTurn !== undefined && !TURN_SAFE_COMMANDS.has(chosen.name)) {
							state.commandMenu = undefined;
							state.commandMenuDismissed = true;
							host.setStatus(`/${chosen.name} is unavailable while a turn is running`, "notice");
							deps.render();
							return;
						}
						host.executeCommand(chosen);
					},
				},
				deps.render,
			)
		) {
			return;
		}

		const key = menuKey(text);
		if (key === "up" || key === "down") {
			host.moveCommandMenu(key === "up" ? -1 : 1);
			return;
		}
		if (key === "tab") {
			const chosen = state.commandMenu.items[state.commandMenu.cursor];
			if (chosen === undefined) return;
			// 有二级选择面板的命令，Tab 等同于回车：直接打开面板；一轮进行中只放行安全命令
			const opensPanel =
				(chosen.name === "model" && host.options.modelMenu !== undefined) ||
				(chosen.name === "effort" && host.options.effortMenu !== undefined) ||
				(chosen.name === "session" && host.options.sessionMenu !== undefined);
			if (opensPanel && (state.activeTurn === undefined || TURN_SAFE_COMMANDS.has(chosen.name))) {
				host.executeCommand(chosen);
				return;
			}
			// 其余命令只补全命令名与一个空格，补全面板保持打开：Tab 不执行也不收起
			host.setInput(`/${chosen.name} `);
			deps.render();
			return;
		}
		if (key === "escape") {
			state.commandMenu = undefined;
			// 记下这次主动关闭：输入不变就不再自动弹回来
			state.commandMenuDismissed = true;
			deps.render();
			return;
		}
	}

	if (state.fileMenu !== undefined) {
		// 文件补全和命令补全一样不抢输入焦点，只接管选择相关的按键与鼠标
		const menu = state.fileMenu;
		const filePanelTop = menuPanelTop(state, host.options);
		const insert = (): void => {
			host.insertFileReference();
		};
		if (
			handleMenuMouse(
				mouseOf(),
				{
					hitItem: (row) =>
						menuIndexAtRow(row, filePanelTop, menu.items.length, menu.scrollTop, menu.cursor),
					cursor: () => menu.cursor,
					select: (index) => {
						menu.cursor = index;
						menu.scrollTop = Math.max(0, Math.min(index, menu.items.length - 1));
					},
					move: (delta) => host.moveFileMenu(delta),
					confirm: insert,
				},
				deps.render,
			)
		) {
			return;
		}

		const key = menuKey(text);
		if (key === "up" || key === "down") {
			host.moveFileMenu(key === "up" ? -1 : 1);
			return;
		}
		if (key === "tab" || key === "enter") {
			insert();
			return;
		}
		if (key === "escape") {
			host.closeFileMenu(true);
			deps.render();
			return;
		}
	}

	// 输入框失焦后，回车只负责把焦点抢回来：这一下不提交，避免误发已经打好的内容。
	// 只认单独的换行块，粘贴进来的多行内容不会被当成聚焦键吞掉。
	if (!state.focused && (withoutMouse === "\r" || withoutMouse === "\n")) {
		state.focused = true;
		deps.render();
		return;
	}
	// Ctrl+V / Alt+V 读剪贴板里的图片；终端自己处理的文本粘贴不会走到这里
	const clipboardKey = withoutMouse === "\x16" || withoutMouse === "\x1bv" || withoutMouse === "\x1bV";
	if (clipboardKey && !state.pasting) {
		host.attachClipboardImage();
		return;
	}
	// 拖入终端只会得到一段路径文本：整段就是一个现有图片时插成正文标记，不填进输入框
	if (state.commandMenu === undefined && !state.pasting) {
		const dragged = host.draggedImagePath(text);
		if (dragged !== undefined) {
			host.attachImagePath(dragged);
			return;
		}
	}

	const previous = state.input;
	const previousCursor = state.inputCursor;
	if (text === "\x05" && state.commandMenu === undefined) {
		if (toggleLastExpandable(state.turns)) {
			markTranscriptDirty(state);
			state.follow = false;
			deps.render();
		}
		return;
	}
	if (text === "\x0f" && state.commandMenu === undefined) {
		if (toggleLastToolResult(state.turns)) {
			markTranscriptDirty(state);
			state.follow = false;
			deps.render();
		}
		return;
	}
	const scroll = scrollKey(text);
	if (scroll !== undefined) {
		const limit = host.maxScroll();
		if (scroll === "pageUp") {
			state.scrollTop = Math.max(0, state.scrollTop - mainHeight);
			state.follow = false;
		} else if (scroll === "pageDown") {
			state.scrollTop = Math.min(limit, state.scrollTop + mainHeight);
			state.follow = state.scrollTop >= limit;
		} else {
			state.scrollTop = 0;
			state.follow = false;
		}
		deps.render();
		return;
	}

	// 排队消息的三个操作：Esc 中止并立即发队首，Alt+Up 撤回队尾，Alt+Down 丢弃队尾
	if (state.commandMenu === undefined) {
		if (withoutMouse === "\x1b" && state.activeTurn !== undefined && state.queued.length > 0) {
			// 中止默认不续发队列；这是唯一的例外——使用者明确要求立刻发出去
			state.sendQueuedAfterAbort = true;
			host.options.approval?.denyAll();
			state.activeTurn.controller.abort();
			host.setStatus(ABORTING);
			deps.render();
			return;
		}

		const queueKey = queuedEditKey(withoutMouse);
		// 撤回与编辑是同一条路径：取回即出队，清掉文字就是取消
		if (queueKey === "recall") {
			const recalled = state.queued.pop();
			if (recalled !== undefined) {
				// 队列里的正文已经带着标记，把对应图片数据接回来，删除标记仍能取消那张图
				for (const image of recalled.images) {
					const token = imageMarker(image.name);
					if (!state.pendingImages.some((item) => item.token === token)) {
						state.pendingImages.push({ token, image });
					}
				}
				host.setInput(state.input.length === 0 ? recalled.text : `${recalled.text}\n${state.input}`);
				host.updateCommandMenu();
				host.updateFileMenu();
				deps.render();
				return;
			}
		}
		// 丢弃不回填输入框：排错了的消息直接扔掉，不必先取回再删
		if (queueKey === "discard" && state.queued.pop() !== undefined) {
			deps.render();
			return;
		}
	}

	const step = historyKey(withoutMouse);
	if (step !== undefined && state.commandMenu === undefined) {
		if (state.input.includes("\n")) {
			const moved = moveInputVertical(state.input, state.inputCursor, step);
			if (moved !== undefined && moved !== state.inputCursor) {
				host.setInput(state.input, moved);
				deps.render();
				return;
			}
		}
		const consumed = host.recallHistory(step);
		if (consumed) return;
	}

	const edit = editInput(state.input, state.inputCursor, withoutMouse, state.pasting);
	state.pasting = edit.pasting;
	if (edit.text !== previous) {
		state.historyIndex = -1;
		// 输入变了，之前用 Esc 关掉补全面板的决定就作废：新内容该有自己的补全
		state.commandMenuDismissed = false;
		state.fileMenuDismissed = false;
	}
	// 文字一变，选择面板就收掉：面板由命令打开，输入一旦不再是那条命令它就失去意义；
	// 命令补全面板相反，跟着新输入继续过滤
	if (edit.text !== previous && host.modalMenuOpen()) {
		state.modelMenu = undefined;
		state.effortMenu = undefined;
		state.sessionMenu = undefined;
	}
	host.setInput(edit.text, edit.cursor);
	host.updateCommandMenu();
	host.updateFileMenu();
	// 配置不可用时主区域要一直保留警告，不能因为敲了字就切到对话流；
	// 斜杠命令同样不是对话内容，补全面板与帮助页都盖在启动画面上
	if (state.input.length > 0 && !state.input.startsWith("/") && state.ready) state.hasInput = true;

	if (edit.submit) {
		const submitted = host.submit();
		if (!submitted && (focusChanged || scrollChanged)) deps.render();
		return;
	}
	if (
		state.input !== previous ||
		state.inputCursor !== previousCursor ||
		edit.handled ||
		focusChanged ||
		hoverChanged ||
		scrollChanged
	) {
		deps.render();
	}
}
