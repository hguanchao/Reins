import { inputView } from "../view/footer.ts";
import { imageMarker } from "../image.ts";
import { MOUSE_BUTTON_MASK, MOUSE_MOTION_BIT, MOUSE_WHEEL_BIT, MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, editInput, historyKey, menuKey, moveInputVertical, queuedEditKey, stripFocusEvents, stripMouseEvents } from "./keys.ts";
import type { MouseInput } from "./keys.ts";
import { scrollButtonHit, scrollButtonPlacement } from "../view/scroll-button.ts";
import { ABORTING } from "../render/status.ts";
import { menuPanelTop } from "../runtime/approval.ts";
import { completeCommandMenu } from "../runtime/panels.ts";
import { commandMenuHeight } from "../panel/command-menu.ts";
import { fileMenuHeight } from "../panel/file-menu.ts";
import { applyDragScroll, applyWheelScroll, handleScrollKey, handleToggleKey, trackClick } from "./scroll.ts";
import type { InputDeps } from "./deps.ts";
import { handleMenuMouse, inlineMenuTarget } from "./menus.ts";
import { toolHeaderInView } from "../transcript.ts";
import type { TuiHost } from "../runtime/types.ts";

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
	const withoutMouse = stripMouseEvents(stripFocusEvents(text));
	let focusChanged = false;
	let hoverChanged = false;
	let wheelSteps = 0;
	let dragRow: number | undefined;
	/** 任何菜单面板开着时滚轮都不该动对话流：面板盖着，滚动看不见的底层内容只会让人以为界面没反应。 */
	const menuOpen = host.menuOpen();
	/** 置底按钮；命中判定与悬停都用同一份位置，保证画在哪里就能点在哪里。 */
	const bottomButton = menuOpen ? undefined : scrollButtonPlacement(width, mainHeight);
	/** 按钮此刻是否真的画着：没画出来的位置不该被点中，也不该响应悬停。 */
	const buttonShown = bottomButton !== undefined && state.scrollTop < host.maxScroll();
	/** 补全面板画在输入框上方，落在它上面的点击不参与焦点判定。 */
	const completionOpen = state.commandMenu !== undefined || state.fileMenu !== undefined;
	/** 行内补全面板的屏幕范围；滚轮停在面板上时交给菜单，停在面板外时滚对话流。 */
	let inlineMenuTop: number | undefined;
	let inlineMenuBottom = 0;
	if (state.commandMenu !== undefined) {
		inlineMenuTop = menuPanelTop(state, host.options);
		inlineMenuBottom = inlineMenuTop + commandMenuHeight(state.commandMenu.items.length);
	} else if (state.fileMenu !== undefined) {
		inlineMenuTop = menuPanelTop(state, host.options);
		inlineMenuBottom = inlineMenuTop + fileMenuHeight(state.fileMenu.items.length);
	}

	for (const event of mouseOf()) {
		const motion = (event.button & MOUSE_MOTION_BIT) !== 0 && (event.button & MOUSE_WHEEL_BIT) === 0;
		// 滚轮向上（64）的低两位同样是 0，不能只按低两位判断是不是左键
		const left = (event.button & MOUSE_BUTTON_MASK) === 0 && (event.button & MOUSE_WHEEL_BIT) === 0;
		// 低两位是 3 表示没有按键：1003 模式下这类事件只是指针在移动，也就是悬停
		const hover = motion && (event.button & MOUSE_BUTTON_MASK) === 3;
		const overInlineMenu =
			inlineMenuTop !== undefined && event.row >= inlineMenuTop && event.row < inlineMenuBottom;

		if (hover) {
			const over = buttonShown && scrollButtonHit(bottomButton, event.row, event.column);
			if (over !== state.buttonHovered) {
				state.buttonHovered = over;
				hoverChanged = true;
			}
			continue;
		}

		if (event.press && event.button === MOUSE_WHEEL_UP) {
			// 停在菜单上时滚轮归菜单；停在别处时仍然滚动对话流
			if (!overInlineMenu) wheelSteps -= 1;
		} else if (event.press && event.button === MOUSE_WHEEL_DOWN) {
			if (!overInlineMenu) wheelSteps += 1;
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

			// 双击思考标题、工具组、任务卡或子代理组，展开或收起
			const doubleClick = trackClick(state, event);
			if (doubleClick && host.toggleTranscriptAt(event.row, event.column, mainHeight, width)) {
				return;
			}

			// 单击工具行把它记成 Ctrl+G 的查看目标；展开/收起仍归双击
			if (event.column < width - 1) {
				const selected = toolHeaderInView(
					host.currentTranscript(width),
					mainHeight,
					state.scrollTop,
					event.row,
				);
				if (selected !== undefined) state.viewerTool = selected;
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

			// 落在补全面板上的点击交给下面的菜单分支处理，不能拿它改输入框焦点：
			// 面板画在输入框上方，按位置算就是「输入框外」，会把焦点判成失焦，
			// 于是紧接着的回车只会被当成抢回焦点，选中的命令反而执行不了
			if (completionOpen && event.row >= menuPanelTop(state, host.options)) continue;

			// 可点区域要含上下两条边框：使用者把那个方框整体当成输入框，点在边框上
			// 却没有任何反应，会以为界面卡住了
			const inputLineTotal = inputView(state.input, width, state.inputCursor).lines.length;
			const inputTop = host.inputTopRow(mainHeight);
			const insideInput =
				event.row >= inputTop - 1 && event.row <= inputTop + inputLineTotal;
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

	applyWheelScroll(host, state, wheelSteps);
	if (dragRow !== undefined) applyDragScroll(host, state, dragRow, mainHeight);
	const scrollChanged = state.scrollTop !== beforeScroll;

	if (state.commandMenu !== undefined) {
		// 命令补全面板不拦截文字输入，只接管上下键、Esc 与鼠标
		const commandPanelTop = menuPanelTop(state, host.options);
		const menu = state.commandMenu;
		if (
			handleMenuMouse(
				mouseOf(),
				inlineMenuTarget(
					menu,
					commandPanelTop,
					commandMenuHeight(menu.items.length),
					() => completeCommandMenu(host),
				),
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
			completeCommandMenu(host);
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
				inlineMenuTarget(menu, filePanelTop, fileMenuHeight(menu.items.length), insert),
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

	/** 任何要编辑输入框的动作都把输入焦点收回来；只滚对话流或展开内容的按键不算。 */
	const focusInput = (): void => {
		if (state.focused) return;
		state.focused = true;
		focusChanged = true;
	};

	// Ctrl+G：把最近一块长内容（工具输出/详情、思考、提示）打开成整屏页
	if (
		withoutMouse === "\x07" &&
		!state.pasting &&
		state.commandMenu === undefined &&
		state.fileMenu === undefined &&
		!host.modalMenuOpen()
	) {
		host.openViewer();
		return;
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
		focusInput();
		host.attachClipboardImage();
		return;
	}
	// 拖入终端只会得到一段路径文本：整段就是一个现有图片时插成正文标记，不填进输入框
	if (state.commandMenu === undefined && !state.pasting) {
		const dragged = host.draggedImagePath(text);
		if (dragged !== undefined) {
			focusInput();
			host.attachImagePath(dragged);
			return;
		}
	}

	const previous = state.input;
	const previousCursor = state.inputCursor;
	if (state.commandMenu === undefined && handleToggleKey(state, text)) {
		deps.render();
		return;
	}
	if (handleScrollKey(host, state, text, mainHeight)) {
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
				focusInput();
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
				focusInput();
				host.setInput(state.input, moved);
				deps.render();
				return;
			}
		}
		const consumed = host.recallHistory(step);
		if (consumed) {
			if (!state.focused) {
				state.focused = true;
				deps.render();
			}
			return;
		}
	}

	// 真正落到编辑器的键盘输入都表示使用者想继续编辑：把焦点收回来。
	// 否则文字能进输入框，边框与光标却还是失焦态，紧接着的回车也只被当成抢焦点。
	if (withoutMouse.length > 0 && withoutMouse !== "\x1b") focusInput();

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
