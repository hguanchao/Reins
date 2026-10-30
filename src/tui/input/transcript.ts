import { inputView } from "#src/tui/view/footer.ts";
import { imageMarker } from "#src/tui/image.ts";
import { MOUSE_BUTTON_MASK, MOUSE_MOTION_BIT, MOUSE_WHEEL_BIT, MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, editInput, historyKey, menuKey, moveInputVertical, queuedEditKey, stripFocusEvents, stripMouseEvents } from "#src/tui/input/keys.ts";
import type { MouseInput } from "#src/tui/input/keys.ts";
import { scrollButtonHit, scrollButtonPlacement } from "#src/tui/view/scroll-button.ts";
import { STATUS } from "#src/tui/copy.ts";
import { armClear, clearDraft, disarmClear, restoreDraft } from "#src/tui/input/draft.ts";
import { pasteInsertion } from "#src/tui/paste.ts";
import { menuPanelTop } from "#src/tui/runtime/approval.ts";
import { menuVisibleLimit } from "#src/tui/runtime/geometry.ts";
import { completeCommandMenu } from "#src/tui/runtime/panels.ts";
import { commandMenuHeight } from "#src/tui/panel/command-menu.ts";
import { fileMenuHeight } from "#src/tui/panel/file-menu.ts";
import { applyDragScroll, applyWheelScroll, handleScrollKey, handleToggleKey, trackClick } from "#src/tui/input/scroll.ts";
import type { InputDeps } from "#src/tui/input/deps.ts";
import { handleMenuMouse, inlineMenuTarget } from "#src/tui/input/menus.ts";
import { selectionPoint, selectionSpans, selectionText, toolHeaderInView } from "#src/tui/transcript.ts";
import type { TuiHost } from "#src/tui/runtime/types.ts";

export function handleTranscriptInput(
	host: TuiHost,
	deps: InputDeps,
	text: string,
	mouseOf: () => readonly MouseInput[],
	pasting: boolean,
): void {
	const state = host.state;
	const width = host.terminalWidth();
	const mainHeight = host.mainAreaHeight();
	const menuLimit = menuVisibleLimit(state);
	const beforeScroll = state.scrollTop;
	const withoutMouse = stripMouseEvents(stripFocusEvents(text));
	let focusChanged = false;
	let hoverChanged = false;
	let selectionChanged = false;
	// 键盘输入说明已经离开鼠标拖选；松开事件丢失时不能把高亮留在屏幕上
	if (withoutMouse.length > 0 && state.selection !== undefined) {
		state.selection = undefined;
		selectionChanged = true;
	}
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
			// 没有按键的移动只说明指针在挪；松开事件丢失时顺手清掉残留选区
			if (state.selection !== undefined) {
				state.selection = undefined;
				selectionChanged = true;
			}
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
				state.selection = undefined;
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

			// 左键在对话流里按下：开始一次拖选。单击不动没有选区，松开时不会复制
			if (event.column < width - 1) {
				const point = selectionPoint(
					host.currentTranscript(width),
					mainHeight,
					state.scrollTop,
					event.row,
					event.column,
				);
				if (point !== undefined) {
					state.selection = { anchor: point, focus: point };
					selectionChanged = true;
				} else if (state.selection !== undefined) {
					state.selection = undefined;
					selectionChanged = true;
				}
			} else if (state.selection !== undefined) {
				state.selection = undefined;
				selectionChanged = true;
			}

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
			if (state.draggingScrollbar) {
				dragRow = event.row;
			} else if (state.selection !== undefined) {
				const point = selectionPoint(
					host.currentTranscript(width),
					mainHeight,
					state.scrollTop,
					event.row,
					event.column,
				);
				if (
					point !== undefined &&
					(point.line !== state.selection.focus.line || point.cell !== state.selection.focus.cell)
				) {
					state.selection = { anchor: state.selection.anchor, focus: point };
					selectionChanged = true;
				}
			}
		} else if (!event.press) {
			state.draggingScrollbar = false;
			if (state.selection !== undefined) {
				const selection = state.selection;
				state.selection = undefined;
				selectionChanged = true;
				// 只有真的拖过一段才复制；原地点击与双击不该带走任何文字
				if (selectionSpans(selection)) {
					const text = selectionText(host.currentTranscript(width), selection);
					if (text.trim().length > 0) host.copyText(text);
				}
			}
		}
	}

	// 滚轮一旦滚动，选区的行号就不在同一屏上了；残留高亮跟着清掉
	if (wheelSteps !== 0 && state.selection !== undefined) {
		state.selection = undefined;
		selectionChanged = true;
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
					commandMenuHeight(menu.items.length, menuLimit),
					() => completeCommandMenu(host),
					menuLimit,
				),
				deps.render,
			)
		) {
			return;
		}

		const key = menuKey(text);
		if (key === "up" || key === "down") {
			host.moveMenu(key === "up" ? -1 : 1);
			return;
		}
		if (key === "tab") {
			completeCommandMenu(host, true);
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
				inlineMenuTarget(menu, filePanelTop, fileMenuHeight(menu.items.length, menuLimit), insert, menuLimit),
				deps.render,
			)
		) {
			return;
		}

		const key = menuKey(text);
		if (key === "up" || key === "down") {
			host.moveMenu(key === "up" ? -1 : 1);
			return;
		}
		if (key === "tab" || key === "enter") {
			if (menu.items.length > 0) {
				insert();
				return;
			}
			// 没有匹配时 Tab 仍然吞掉（补全无事可做），回车放行给提交：
			// 使用者写的是一条带 @ 的普通消息，不该因为补全没命中就发不出去
			if (key === "tab") return;
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
		!pasting &&
		state.commandMenu === undefined &&
		state.fileMenu === undefined &&
		!host.modalMenuOpen()
	) {
		host.openViewer();
		return;
	}

	// Ctrl+Z：撤销上一次清空；清空之后又打了字就不动，免得覆盖更新的内容
	if (withoutMouse === "\x1a" && !pasting && restoreDraft(host, state)) {
		deps.render();
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
	if (clipboardKey && !pasting) {
		focusInput();
		host.attachClipboardImage();
		return;
	}
	// 拖入终端只会得到一段路径文本：整段就是一个现有图片时插成正文标记，不填进输入框
	if (state.commandMenu === undefined && !pasting) {
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
			state.activeTurn.controller.abort("user");
			host.setStatus(STATUS.stopping);
			deps.render();
			return;
		}
		// 空闲时连按两次 Esc 才清空（含多行与图片附件）：整段草稿不该被一下按掉。
		// 回合中的 Esc 属于中止语义，不在这里抢；输入框为空时 Esc 无事可做。
		if (withoutMouse === "\x1b" && state.activeTurn === undefined) {
			if (state.input.length > 0 || state.pendingImages.length > 0) {
				if (state.escClearArmed) {
					clearDraft(host, state);
				} else {
					armClear(state, () => {
						disarmClear(state);
						// 只收起自己那条提示：期间可能已有别的状态写进来，不能一并抹掉
						if (state.statusText === STATUS.clearArmed) host.clearStatus();
						deps.render();
					});
					host.setStatus(STATUS.clearArmed, "notice");
				}
				deps.render();
				return;
			}
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
			// 多行时方向键只做光标移动：到首/末行的边界就停住，不翻历史——
			// 长草稿不会在按一下 ↑ 后被一条历史记录意外替换；要翻历史先退回单行
			const moved = moveInputVertical(state.input, state.inputCursor, step);
			if (moved === undefined) return;
			if (moved !== state.inputCursor) {
				focusInput();
				host.setInput(state.input, moved);
				deps.render();
			}
			return;
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

	// 粘贴区间跨块时由调用方记着，这里只按传进来的状态处理本块
	const edit = editInput(state.input, state.inputCursor, withoutMouse, pasting, (text, before) =>
		pasteInsertion(state.pastes, text, before),
	);
	if (edit.text !== previous) {
		state.historyIndex = -1;
		// 已经重新开始打字，Ctrl+Z 不会再覆盖新内容，那条撤销提示别再挂着
		if (state.statusText === STATUS.cleared) host.clearStatus();
		// 输入变了，之前用 Esc 关掉补全面板的决定就作废：新内容该有自己的补全
		state.commandMenuDismissed = false;
		state.fileMenuDismissed = false;
	}
	// 去掉尾随空白后内容才真正变化时才收起选择面板：命令名后的空格只是分隔符，
	// 多敲一个空格不该把已经打开的二级菜单关掉。命令补全面板相反，跟着新输入继续过滤
	if (edit.text.trimEnd() !== previous.trimEnd() && host.modalMenuOpen()) {
		state.modelMenu = undefined;
		state.effortMenu = undefined;
		state.sessionMenu = undefined;
	}
	host.setInput(edit.text, edit.cursor);
	host.updateCommandMenu();
	host.updateFileMenu();
	// 配置不可用时主区域要一直保留警告，不能因为敲了字就切到对话流。
	// 这里只记录「对话已经开始」；斜杠命令不算对话内容，输入框里的字由渲染层临时收起启动画面。
	if (state.input.length > 0 && !state.input.startsWith("/") && state.ready) state.hasInput = true;

	if (edit.submit) {
		const submitted = host.submit();
		if (!submitted && (focusChanged || scrollChanged || selectionChanged)) deps.render();
		return;
	}
	if (
		state.input !== previous ||
		state.inputCursor !== previousCursor ||
		edit.handled ||
		focusChanged ||
		hoverChanged ||
		scrollChanged ||
		selectionChanged
	) {
		deps.render();
	}
}
