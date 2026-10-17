import type { AgentEvent } from "../../agent/events.ts";
import type { NotifyMode } from "../../config/config-file.ts";
import {
	Clipboard,
	colorSupport,
	KeyDecoder,
	mapLine,
	padLine,
	plain,
	ScreenRegion,
	styled,
	type ClipboardPort,
	type KeyEvent,
	type Line,
	type Terminal,
} from "../../tui/index.ts";
import type { InteractiveFrontend, InteractiveRuntime } from "../../tui/frontend.ts";
import { isBuiltinCommand, runBuiltin } from "./commands.ts";
import { ConversationController } from "./conversation-controller.ts";
import { DIALOG_OPTIONS, dialogDecision, type ConfirmDialog } from "./dialog.ts";
import { panelRows } from "./dialog-view.ts";
import { footerHints, footerRow, runningRow } from "./footer-view.ts";
import { inputBoxRows, INPUT_CHROME, INPUT_LEFT } from "./input-box.ts";
import { GUTTER_WIDTH, OUTER_PAD } from "./layout.ts";
import { MENU_CHROME_ROWS } from "./menu-view.ts";
import { decideNotify, desktopNotificationsSupported, notificationSequence } from "./notify.ts";
import { PromptController } from "./prompt-controller.ts";
import { railWidth, railCells, RAIL_WIDTH } from "./rail.ts";
import { scrollbarGrabOffset, scrollbarStart } from "./scrollbar.ts";
import { copyNotice } from "./session-format.ts";
import { ACCENT, BAD, PASTE_BG, THEME, WARN } from "./theme.ts";

/**
 * 交互式界面。
 *
 * 界面运行在终端的备用屏里，整块屏幕都归它，从上到下四段：顶部状态行、会话区（右侧一格一回合
 * 的轨道）、输入框、快捷键条。一句话都没说之前，会话区摆的是入口框——首屏。
 *
 * 主区按「块」排版：最左一列竖线标出块类型，正文前留两列；使用者消息整块铺底并在上下各留
 * 一行，思考和工具块带彩色竖线。右侧一列是回合轨道，一列是滚动条。
 *
 * 主区的交互与输入框分开：单击块选中并画选中框，300ms 内再次单击切换折叠；Tab 在输入框与
 * 主区之间切换焦点，主区里 j/k 选条目、e 折叠、h/l 收起/展开、g/G 到顶/底、E 全部折叠、
 * Ctrl+E 折叠所有思考块。拖选文本与滚动条在两边都可用。
 *
 * 备用屏没有终端自带的回滚缓冲，回看历史因此由会话区自己滚动：PageUp/PageDown 翻页，
 * Ctrl+P/Ctrl+N 逐行，滚轮向上向下，翻阅时 Home/End 跳到首尾。翻阅期间新到的内容不会把画面
 * 推走——视口记的是内容里的绝对行号，而流式输出只往末尾加行；只有发出新的一句时才回到末尾。
 * 会话区右侧还有滚动条；鼠标拖选文本后松开即复制，右键也能复制当前选区。
 *
 * 复制先试平台命令，再试 tmux 缓冲与 OSC 52，并把内容另存一份文件：任何一条路成功都不算
 * 静默失败。输入框支持 Ctrl+V 读系统剪贴板；多行或很大的粘贴折成原子 chip，提交时再展开，
 * 再次粘贴同一段内容则把 chip 展开。输入 `/` 打开命令下拉，输入 `@` 打开文件下拉；主区里
 * 悬停轨道刻度可预览回合，悬停时间戳可看完整日期，选中块右上角有复制按钮。
 *
 * 界面接管终端期间，按键全部由这里解释，因此 Ctrl+C 不再产生信号：它与 Esc 一起用来中止
 * 当前这一轮；空闲时它们清空输入，输入为空时 Ctrl+C 才退出。退出前必须把备用屏交还、
 * 终端恢复原状——留在原始模式里，使用者的 shell 会连回显都没有。
 */

/** 会话区与确认卡片的最外圈留白由 layout.ts 统一规定。 */

/** 输入框之外的固定行：边框上下两条、下面的快捷键条。 */
const PROMPT_CHROME_ROWS = 3;

/** 跑起来时多出的两行：空行与回合状态行。 */
const RUNNING_ROWS = 2;

/** 滚轮一格翻几行。终端只报「上滚」「下滚」，格与行之间的换算由界面定。 */
const WHEEL_LINES = 3;

const PROMPT: Line = styled("❯ ", ACCENT);

export interface FrontendOptions {
	readonly terminal: Terminal;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** 测试可以换成不碰系统剪贴板的实现。 */
	readonly clipboard?: ClipboardPort;
}

export class TerminalFrontend implements InteractiveFrontend {
	readonly #terminal: Terminal;
	readonly #clipboard: ClipboardPort;
	readonly #region: ScreenRegion;
	readonly #desktopNotify: boolean;
	readonly #prompt: PromptController;
	readonly #keys = new KeyDecoder();
	readonly #conversation: ConversationController;

	#runtime: InteractiveRuntime | undefined;
	#dialog: ConfirmDialog | undefined;
	/** 审批面板当前聚焦的选项；上/下键移动，回车确认。 */
	#dialogFocus = 0;
	#focus: boolean | undefined;
	#notifyMode: NotifyMode = "auto";
	#activity = "";
	#running = false;
	#abort: AbortController | undefined;
	#ticker: NodeJS.Timeout | undefined;
	#escapeTimer: NodeJS.Timeout | undefined;
	/** 完成闪烁过期后再画一帧，免得最后一帧停在绿色上。 */
	#flashTimer: NodeJS.Timeout | undefined;
	/** 当前焦点在哪：输入框还是主区。 */
	#pane: "prompt" | "scrollback" = "prompt";
	/** 终端光标当前是否可见，避免每帧都写一次显隐序列。 */
	#cursorVisible = true;
	/** 拖动滚动条时，抓点离滑块顶端的行数。 */
	#scrollbarGrab: number | undefined;
	/** 输入框在屏幕上的起始行。 */
	#editorTop = 0;
	/** 下拉在屏幕上的起始行；鼠标行号减它得到候选行。 */
	#menuTopScreen = 0;
	/** 底部临时提示（复制成功之类），过一会儿让回给快捷键条。 */
	#notice = "";
	#noticeTimer: NodeJS.Timeout | undefined;
	/** 本轮开始的时刻。事件里没有耗时，指示器按它算「这一轮跑了多久」。 */
	#turnStartedAt = 0;
	#done: (() => void) | undefined;
	/** 终端已经交还，此后不再往屏幕上写任何东西 */
	#stopped = false;

	constructor(options: FrontendOptions) {
		this.#terminal = options.terminal;
		this.#clipboard =
			options.clipboard ??
			new Clipboard({
				env: options.env,
				write: (sequence) => this.#terminal.write(sequence),
			});
		this.#prompt = new PromptController({
			commands: () => this.#runtime?.commands ?? [],
			onChange: () => this.#refresh(),
		});
		this.#region = new ScreenRegion(options.terminal, { colors: colorSupport(options.env) });
		this.#desktopNotify = desktopNotificationsSupported(options.env);
		this.#conversation = new ConversationController(this.#entryWidth(options.terminal.size().cols));
	}

	async run(runtime: InteractiveRuntime): Promise<void> {
		this.#runtime = runtime;
		this.#notifyMode = runtime.notify;
		this.#conversation.setCwd(runtime.cwd);
		this.#prompt.loadFileIndex(runtime.cwd);
		this.#stopped = false;
		this.#startTerminal();

		try {
			runtime.setConfirmer((question, detail) => this.#ask(question, detail));
			this.#refresh();

			await new Promise<void>((resolve) => {
				this.#done = resolve;
			});
		} finally {
			this.#restoreTerminal();
			runtime.setConfirmer(undefined);
			// 备用屏一交还，整个对话就从屏幕上消失了。主屏上留下接续它的命令就够了。
			// 会话只留在内存里时不能给这条命令：它跑起来会找不到东西，而使用者以为刚才
			// 那段对话还在
			this.#terminal.write(
				runtime.session.path === null
					? "This session was not saved to a file and is lost on restart (session-plugin is disabled or failed to load).\n"
					: `reins --resume ${runtime.session.id}\n`,
			);
			this.#runtime = undefined;
		}
	}

	/** 会话区与确认卡片的可用宽度：它们左侧留两列。 */
	#body(cols: number): number {
		return Math.max(16, cols - OUTER_PAD);
	}

	/** 条目总宽：正文区的宽度再扣掉右侧给轨道与滚动条的两列。 */
	#entryWidth(cols: number): number {
		return Math.max(1, this.#body(cols) - GUTTER_WIDTH);
	}

	#startTerminal(): void {
		this.#terminal.setRawMode(true);
		this.#terminal.setBracketedPaste(true);
		this.#terminal.setFocusReporting(true);
		// 滚轮、拖选与滚动条拖动都靠终端上报鼠标；代价是终端自己的选中要让位给 Shift
		this.#terminal.setMouseTracking(true);
		// 整块屏幕都归本程序：主屏原封不动，退出时原样交还
		this.#terminal.setAlternateScreen(true);
		this.#terminal.onInput((chunk) => this.#onInput(chunk));
		this.#terminal.onResize(() => this.#onResize());
		// 进程被别的方式结束（信号、崩溃）时也要把终端还原，否则 shell 会留在原始模式里
		process.once("exit", this.#restoreOnExit);
	}

	#restoreTerminal(): void {
		this.#stopped = true;
		this.#region.clear();
		this.#stopTicker();
		if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
		if (this.#flashTimer !== undefined) clearTimeout(this.#flashTimer);
		if (this.#noticeTimer !== undefined) clearTimeout(this.#noticeTimer);
		this.#terminal.setAlternateScreen(false);
		this.#terminal.setMouseTracking(false);
		this.#terminal.setBracketedPaste(false);
		this.#terminal.setFocusReporting(false);
		this.#cursorVisible = true;
		this.#terminal.setCursorVisible(true);
		this.#terminal.setRawMode(false);
		process.off("exit", this.#restoreOnExit);
	}

	/** 进程退出时的兜底还原。这里不能做异步的事，只能把控制序列写出去。 */
	readonly #restoreOnExit = (): void => {
		try {
			this.#terminal.setAlternateScreen(false);
			this.#terminal.setMouseTracking(false);
			this.#terminal.setBracketedPaste(false);
			this.#terminal.setFocusReporting(false);
			this.#terminal.setCursorVisible(true);
			this.#terminal.setRawMode(false);
		} catch {
			// 退出路径上再抛错没有任何意义
		}
	};

	#onInput(chunk: string): void {
		this.#handle(this.#keys.push(chunk));
		// 只剩一个孤立的 ESC 时，等一小会儿看它是不是某个序列的开头
		if (chunk.endsWith("\x1b")) {
			if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
			this.#escapeTimer = setTimeout(() => this.#handle(this.#keys.flush()), 30);
		}
	}

	#handle(events: readonly KeyEvent[]): void {
		for (const event of events) {
			if (event.type === "focus") {
				this.#focus = event.focused;
				continue;
			}
			if (event.type === "wheel") {
				const wheelRow = event.row - 1;
				const relative = wheelRow - this.#menuTopScreen;
				// 面板第一行是框线，候选从它下面一行开始
				if (
					relative >= MENU_CHROME_ROWS &&
					relative < MENU_CHROME_ROWS + this.#prompt.menuVisible
				) {
					this.#prompt.scrollMenu(event.direction === "up" ? -1 : 1);
					this.#refresh();
					continue;
				}
				this.#scrollBy(event.direction === "up" ? -WHEEL_LINES : WHEEL_LINES);
				continue;
			}
			// 弹窗打开时鼠标只让滚轮过：拖选和拖动滚动条都先放一放
			if (event.type === "mouse") {
				if (this.#dialog === undefined) this.#handleMouse(event);
				continue;
			}
			// 翻阅在任何时候都要能用：确认卡片问的就是上面那次工具调用，得能翻上去看清楚
			if (event.type === "key" && this.#scrollKey(event)) continue;

			if (this.#dialog !== undefined) {
				if (event.type === "key") {
					if (event.name === "ctrl-c" || event.name === "escape") {
						// 询问期间按 Ctrl+C 或 Esc：拒绝，并把这一轮停掉
						this.#interrupt(true);
						continue;
					}
					if (event.name === "up" || event.name === "ctrl-p") {
						this.#moveDialogFocus(-1);
						continue;
					}
					if (event.name === "down" || event.name === "ctrl-n") {
						this.#moveDialogFocus(1);
						continue;
					}
					if (event.name === "enter") {
						this.#answer(DIALOG_OPTIONS[this.#dialogFocus]?.allowed ?? false);
						continue;
					}
				}
				if (event.type === "text") {
					const text = event.text.trim().toLowerCase();
					if (text === "j") {
						this.#moveDialogFocus(1);
						continue;
					}
					if (text === "k") {
						this.#moveDialogFocus(-1);
						continue;
					}
				}
				const decision = dialogDecision(event);
				if (decision !== undefined) this.#answer(decision);
				continue;
			}

			if (event.type === "key" && event.name === "tab") {
				// 下拉打开时 Tab 是接受候选，不切换焦点
				if (this.#prompt.hasMenu()) {
					this.#prompt.handleMenuKey(event);
					this.#refresh();
				} else {
					this.#togglePane();
				}
				continue;
			}

			if (this.#pane === "scrollback") {
				if (event.type === "key") {
					if (event.name === "ctrl-c") {
						this.#interrupt(true);
						continue;
					}
					if (event.name === "ctrl-d") {
						if (this.#prompt.editor.isEmpty && !this.#running) this.#exit();
						continue;
					}
					if (event.name === "escape") {
						// 回合还在跑：Esc 直接中止；空闲时只是把焦点还给输入框
						if (this.#running) this.#interrupt(true);
						else {
							this.#pane = "prompt";
							this.#refresh();
						}
						continue;
					}
					if (event.name === "ctrl-e") {
						this.#conversation.toggleAllThinking();
						this.#refresh();
						continue;
					}
					if (event.name === "down") {
						this.#selectAdjacentBlock(1);
						continue;
					}
					if (event.name === "up") {
						this.#selectAdjacentBlock(-1);
						continue;
					}
					if (event.name === "enter") {
						this.#foldSelected();
						continue;
					}
					if (event.name === "home") {
						this.#conversation.toTop();
						this.#refresh();
						continue;
					}
					if (event.name === "end") {
						this.#conversation.toEnd();
						this.#refresh();
						continue;
					}
				}
				if (event.type === "text") this.#handleScrollbackText(event.text);
				continue;
			}

			if (event.type === "paste") {
				this.#prompt.insertPaste(event.text, false);
				continue;
			}
			if (event.type === "text") {
				this.#prompt.editor.insert(event.text);
				this.#refresh();
				continue;
			}
			this.#handleKey(event);
		}
	}

	/** 主区里的字母键：j/k 选条目，e 折叠，h/l 收起/展开，g/G 到顶/底，E 全部折叠。 */
	#handleScrollbackText(text: string): void {
		for (const char of text) {
			switch (char) {
				case "j":
					this.#selectAdjacentBlock(1);
					break;
				case "k":
					this.#selectAdjacentBlock(-1);
					break;
				case "e":
					this.#foldSelected();
					break;
				case "h":
					this.#changeSelectedFold("collapsed");
					break;
				case "l":
					this.#changeSelectedFold("expanded");
					break;
				case "g":
					this.#conversation.toTop();
					this.#refresh();
					break;
				case "G":
					this.#conversation.toEnd();
					this.#refresh();
					break;
				case "E":
					this.#conversation.toggleAll();
					this.#refresh();
					break;
				case "y":
					this.#copyBlock();
					break;
				case "Y":
					this.#copyBlockMeta();
					break;
				case "H":
					this.#jumpTurn(-1);
					break;
				case "L":
				case "J":
					this.#jumpTurn(1);
					break;
				case "K":
					this.#jumpTurn(-1);
					break;
				default:
					break;
			}
		}
	}

	/** 跳到上一个或下一个回合的开头。 */
	#jumpTurn(delta: number): void {
		this.#conversation.jumpTurn(delta);
		this.#refresh();
	}

	#togglePane(): void {
		if (this.#pane === "prompt") {
			this.#pane = "scrollback";
			if (this.#conversation.selectedBlockId === undefined) this.#conversation.selectFirstVisible();
		} else {
			this.#pane = "prompt";
		}
		this.#refresh();
	}

	#selectAdjacentBlock(delta: number): void {
		this.#conversation.selectAdjacent(delta);
		this.#refresh();
	}

	#foldSelected(): void {
		this.#conversation.foldSelected();
		this.#refresh();
	}

	#changeSelectedFold(mode: "collapsed" | "expanded"): void {
		this.#conversation.changeSelectedFold(mode);
		this.#refresh();
	}

	/**
	 * 鼠标操作：会话区里拖选文本，最右一列拖动滚动条，右键复制当前选区。
	 *
	 * 坐标从终端来，列和行都从 1 开始；这里先换成 0 起，再按会话区各段占的列还原到内容行。
	 */
	#handleMouse(event: Extract<KeyEvent, { type: "mouse" }>): void {
		const cols = this.#terminal.size().cols;
		const row = event.row - 1;
		const col = event.col - 1;

		// 表格与代码块下面的 [Copy …] 标签：按下即写入剪贴板
		if (event.button === "left" && event.action === "down") {
			const copy = this.#conversation.copyTextAt(row, col);
			if (copy !== undefined) {
				this.#writeClipboard(copy);
				return;
			}
		}

		if (event.action === "move") {
			if (this.#conversation.hoverAt(row, col, cols)) this.#refresh();
			return;
		}
		if (
			event.button === "left" &&
			event.action === "down" &&
			col === cols - 1 &&
			row >= 0 &&
			row < this.#conversation.height
		) {
			const grab = scrollbarGrabOffset(row, this.#conversation.total, this.#conversation.height, this.#conversation.window.start);
			if (grab !== undefined) {
				this.#scrollbarGrab = grab;
				this.#scrollTo(scrollbarStart(row, grab, this.#conversation.total, this.#conversation.height));
			}
			return;
		}

		if (event.action === "drag" && this.#scrollbarGrab !== undefined) {
			this.#scrollTo(scrollbarStart(row, this.#scrollbarGrab, this.#conversation.total, this.#conversation.height));
			return;
		}

		if (event.action === "up" && this.#scrollbarGrab !== undefined) {
			this.#scrollbarGrab = undefined;
			return;
		}

		// 轨道在滚动条左边两列：点刻度或箭头跳到对应回合
		if (
			event.button === "left" &&
			event.action === "down" &&
			col >= cols - RAIL_WIDTH &&
			col <= cols - 2 &&
			row >= 0 &&
			row < this.#conversation.height
		) {
			if (railWidth({ width: this.#body(cols), turns: this.#conversation.turns.length }) > 0) {
				const cells = railCells(this.#conversation.height, this.#conversation.turns, this.#conversation.window.start);
				const target = cells[row]?.target;
				if (target !== undefined) this.#scrollTo(target);
			}
			return;
		}

		// 下拉：单击选中，300ms 内再点一次接受；面板首行是框线
		if (event.button === "left" && event.action === "down" && row >= this.#menuTopScreen) {
			const relative = row - this.#menuTopScreen;
			if (
				relative >= MENU_CHROME_ROWS &&
				relative < MENU_CHROME_ROWS + this.#prompt.menuVisible &&
				this.#prompt.clickMenu(relative)
			) {
				this.#pane = "prompt";
				this.#refresh();
				return;
			}
		}

		// 点到输入区：焦点回到输入框；双击粘贴 chip 则把它展开
		if (event.button === "left" && event.action === "down" && row >= this.#conversation.height) {
			this.#pane = "prompt";
			this.#handleEditorClick(row, col);
			this.#refresh();
			return;
		}

		if (event.button === "left" && event.action === "down") {
			const result = this.#conversation.clickBlock(row);
			if (result !== "none") this.#pane = "scrollback";

			const point = this.#conversation.selectionPoint(col, row, this.#entryWidth(cols));
			if (point !== undefined) this.#conversation.beginSelection(point);
			if (result !== "none" || point !== undefined) this.#refresh();
			return;
		}

		if (event.action === "drag") {
			const point = this.#conversation.selectionPoint(col, row, this.#entryWidth(cols));
			if (point !== undefined && this.#conversation.updateSelection(point)) this.#refresh();
			return;
		}

		if (event.action === "up") {
			const text = this.#conversation.finishSelection();
			if (text !== undefined) this.#writeClipboard(text);
			this.#refresh();
			return;
		}

		if (event.button === "right" && event.action === "down") {
			const text = this.#conversation.selectionText();
			if (text !== undefined) this.#writeClipboard(text);
		}
	}

	/** 输入区里的单击：交给输入控制器判断是否落在粘贴 chip 上。 */
	#handleEditorClick(row: number, col: number): void {
		this.#prompt.clickEditor(row - this.#editorTop, col - INPUT_LEFT);
	}

	#scrollTo(index: number): void {
		this.#conversation.scrollTo(index);
		this.#refresh();
	}

	/** 复制选中块的完整正文；折叠状态下也复制全部内容。 */
	#copyBlock(): void {
		if (this.#conversation.selectedBlockId === undefined) return;
		const text = this.#conversation.blockText(this.#conversation.selectedBlockId);
		if (text !== undefined && text.length > 0) this.#writeClipboard(text);
	}

	/** 复制选中块的元信息（工具名与参数）；汇总组按成员逐条复制。 */
	#copyBlockMeta(): void {
		if (this.#conversation.selectedBlockId === undefined) return;
		const text = this.#conversation.blockMeta(this.#conversation.selectedBlockId);
		if (text !== undefined && text.length > 0) this.#writeClipboard(text);
	}

	/**
	 * 从系统剪贴板粘贴。
	 *
	 * inline 为真时跳过 chip 直接插入，对应 Ctrl+Shift+V；否则交给统一的粘贴分流，多行或
	 * 很大的内容会折成 chip。
	 */
	#pasteFromClipboard(inline: boolean): void {
		if (!this.#prompt.pasteFromClipboard(this.#clipboard, inline)) {
			this.#showNotice("Clipboard is empty");
			return;
		}
		this.#refresh();
	}

	#writeClipboard(text: string): void {
		const outcome = this.#clipboard.copy(text);
		this.#showNotice(copyNotice(outcome, text), outcome.delivery === "confirmed" ? 1800 : 5000);
	}

	/** 底部临时提示；过一会儿把位置让回给快捷键条。 */
	#showNotice(text: string, duration = 1500): void {
		this.#notice = text;
		if (this.#noticeTimer !== undefined) clearTimeout(this.#noticeTimer);
		this.#noticeTimer = setTimeout(() => {
			this.#notice = "";
			this.#noticeTimer = undefined;
			this.#refresh();
		}, duration);
		this.#refresh();
	}

	/**
	 * 翻阅会话的按键。用掉了返回 true。
	 *
	 * Home/End 在跟尾时属于输入框（行首行尾），只有正翻阅历史时才是「跳到最早/回到末尾」：
	 * 那时候使用者的注意力在历史里，不在输入框上。
	 */
	#scrollKey(event: Extract<KeyEvent, { type: "key" }>): boolean {
		// 下拉打开时，翻页与 Ctrl+P/N 属于候选列表，不是会话历史
		const menuKey =
			event.name === "pageup" ||
			event.name === "pagedown" ||
			event.name === "ctrl-p" ||
			event.name === "ctrl-n";
		if (menuKey && this.#prompt.hasMenu()) return false;

		switch (event.name) {
			case "pageup":
				this.#scrollPages(-1);
				return true;
			case "pagedown":
				this.#scrollPages(1);
				return true;
			case "ctrl-p":
				this.#scrollBy(-1);
				return true;
			case "ctrl-n":
				this.#scrollBy(1);
				return true;
			case "home":
				if (this.#conversation.window.following) return false;
				this.#conversation.toTop();
				this.#refresh();
				return true;
			case "end":
				if (this.#conversation.window.following) return false;
				this.#conversation.toEnd();
				this.#refresh();
				return true;
			default:
				return false;
		}
	}

	#handleKey(event: Extract<KeyEvent, { type: "key" }>): void {
		if (this.#prompt.handleMenuKey(event)) {
			this.#refresh();
			return;
		}

		switch (event.name) {
			case "enter":
				void this.#submit();
				return;
			case "backspace":
				this.#prompt.editor.backspace();
				break;
			case "delete":
				this.#prompt.editor.deleteForward();
				break;
			case "left":
				this.#prompt.editor.moveLeft();
				break;
			case "right":
				this.#prompt.editor.moveRight();
				break;
			case "home":
			case "ctrl-a":
				this.#prompt.editor.moveHome();
				break;
			case "end":
			case "ctrl-e":
				this.#prompt.editor.moveEnd();
				break;
			case "ctrl-u":
				this.#prompt.editor.deleteToStart();
				break;
			case "ctrl-k":
				this.#prompt.editor.deleteToEnd();
				break;
			case "ctrl-w":
				this.#prompt.editor.deleteWordBefore();
				break;
			case "ctrl-z":
				this.#prompt.editor.undo();
				break;
			case "ctrl-y":
				this.#prompt.editor.redo();
				break;
			case "ctrl-v":
				this.#pasteFromClipboard(false);
				return;
			case "ctrl-shift-v":
				this.#pasteFromClipboard(true);
				return;
			case "newline":
				this.#prompt.editor.insert("\n");
				break;
			case "up":
				if (this.#prompt.editor.isEmpty) this.#prompt.editor.historyPrev();
				else this.#prompt.editor.moveUp();
				break;
			case "down":
				if (this.#prompt.editor.isEmpty) this.#prompt.editor.historyNext();
				else this.#prompt.editor.moveDown();
				break;
			case "ctrl-l":
				// 屏幕可能被别的输出弄乱了，重新画一遍
				this.#region.clear();
				break;
			case "ctrl-c":
				this.#interrupt(true);
				break;
			case "escape":
				this.#interrupt(false);
				break;
			case "ctrl-d":
				if (this.#prompt.editor.isEmpty && !this.#running) this.#exit();
				return;
			default:
				// 其余按键目前没有绑定，按了就当没按
				return;
		}
		this.#refresh();
	}

	async #submit(): Promise<void> {
		const runtime = this.#runtime;
		if (runtime === undefined) return;

		if (this.#running) {
			this.#conversation.appendSystem([
				styled("A turn is still running; wait for it to finish, or press Esc or Ctrl+C to cancel.", WARN),
			]);
			this.#refresh();
			return;
		}

		// 光标前的反斜杠表示续行：换成换行，先不发送
		if (this.#prompt.editor.insertNewlineAfterContinuation()) {
			this.#refresh();
			return;
		}

		const text = this.#prompt.editor.submit();
		if (text.trim().length === 0) {
			this.#refresh();
			return;
		}

		// 新回合从这一行开始；轨道多一格刻度，画面回到末尾——接下来要看的就是它的结果
		this.#pane = "prompt";
		this.#conversation.userTurn(text);
		this.#conversation.toEnd();
		this.#refresh();

		if (text.startsWith("/")) {
			await this.#runCommand(text.slice(1));
			return;
		}

		await this.#runTurn(runtime, text);
	}

	async #runCommand(input: string): Promise<void> {
		const runtime = this.#runtime;
		if (runtime === undefined) return;

		const separator = input.search(/\s/);
		const name = separator < 0 ? input : input.slice(0, separator);
		const args = separator < 0 ? "" : input.slice(separator + 1).trim();

		if (name.length === 0) return;

		try {
			if (isBuiltinCommand(name)) {
				const result = runBuiltin(name, args, {
					runtime,
					notify: () => this.#notifyMode,
					setNotify: (mode) => {
						runtime.setNotify(mode);
						this.#notifyMode = mode;
					},
				});
				if (result === undefined) return;
				this.#conversation.appendSystem(result.lines);
				this.#refresh();
				if (result.exit === true) {
					this.#exit();
					return;
				}
				return;
			}

			const lines = await runtime.runCommand(name, args);
			this.#conversation.appendSystem(lines.map((line) => plain(line)));
			this.#refresh();
		} catch (error) {
			// 命令出错只影响这一条命令，界面继续用
			this.#conversation.appendSystem([styled(error instanceof Error ? error.message : String(error), BAD)], BAD);
			this.#refresh();
		}
	}

	async #runTurn(runtime: InteractiveRuntime, prompt: string): Promise<void> {
		this.#running = true;
		this.#activity = "Thinking";
		this.#turnStartedAt = Date.now();
		const controller = new AbortController();
		this.#abort = controller;
		this.#startTicker();
		this.#refresh();

		try {
			await runtime.createDriver((event) => this.#onAgentEvent(event)).run(prompt, controller.signal);
		} catch (error) {
			// 驱动把可预期的失败都编码进了事件，走到这里说明出了意料之外的事
			this.#conversation.appendSystem(
				[styled(`✗ Error: ${error instanceof Error ? error.message : String(error)}`, BAD)],
				BAD,
			);
		} finally {
			this.#running = false;
			this.#abort = undefined;
			this.#activity = "";
			this.#stopTicker();
			// 中止的回合不算完成，不补耗时行
			if (controller.signal.aborted === false) {
				this.#conversation.turnCompleted(Date.now() - this.#turnStartedAt);
			}
			this.#conversation.clearRunning();
			// 一轮里可能新建了文件；刷新清单，让紧接着的 @ 补全能找到它们
			this.#prompt.loadFileIndex(runtime.cwd);
			this.#refresh();
			this.#notify("Done");
		}
	}

	#onAgentEvent(event: AgentEvent): void {
		const now = Date.now();
		switch (event.type) {
			case "turn_start":
				this.#activity = "Thinking";
				break;
			case "tool_start":
				this.#activity = `Running ${event.name}`;
				break;
			case "tool_end":
				this.#activity = "Thinking";
				break;
			case "compaction_start":
				this.#activity = "Compacting context";
				break;
			case "compaction_end":
			case "compaction_failed":
				this.#activity = "Thinking";
				break;
			default:
				break;
		}

		this.#conversation.handle(event, now);
		this.#refresh();

		if (
			event.type === "tool_end" ||
			event.type === "text_delta" ||
			event.type === "tool_start" ||
			event.type === "error" ||
			event.type === "aborted" ||
			event.type === "run_end"
		) {
			this.#scheduleFlashRefresh();
		}
	}

	/** 完成闪烁只持续几百毫秒，安静下来后也要再画一帧把它落回静态色。 */
	#scheduleFlashRefresh(): void {
		if (this.#flashTimer !== undefined) clearTimeout(this.#flashTimer);
		this.#flashTimer = setTimeout(() => {
			this.#flashTimer = undefined;
			this.#refresh();
		}, 500);
	}

	#interrupt(exitWhenIdle: boolean): void {
		if (this.#dialog !== undefined) {
			// 询问期间按 Ctrl+C：拒绝，并且把这一轮也停掉
			this.#answer(false);
			this.#abort?.abort();
			return;
		}
		if (this.#running) {
			this.#abort?.abort();
			return;
		}
		if (!this.#prompt.editor.isEmpty) {
			this.#prompt.editor.clear();
			this.#refresh();
			return;
		}
		// Esc 在空闲、没有输入时什么都不做：它只用来打断，不承担退出的职责
		if (exitWhenIdle) this.#exit();
	}

	#exit(): void {
		this.#done?.();
	}

	#ask(question: string, detail: string): Promise<boolean> {
		this.#conversation.clearHover();
		return new Promise<boolean>((resolve) => {
			this.#dialog = { question, detail, resolve };
			this.#dialogFocus = 0;
			this.#refresh();
			// 屏幕前的这个人可能正看着别的窗口，这一问必须让他知道
			this.#notify(question);
		});
	}

	#moveDialogFocus(delta: number): void {
		this.#dialogFocus = Math.max(0, Math.min(DIALOG_OPTIONS.length - 1, this.#dialogFocus + delta));
		this.#refresh();
	}

	#answer(allowed: boolean): void {
		const dialog = this.#dialog;
		if (dialog === undefined) return;
		this.#dialog = undefined;
		this.#dialogFocus = 0;
		dialog.resolve(allowed);
		this.#refresh();
	}

	#notify(message: string): void {
		const action = decideNotify({
			mode: this.#notifyMode,
			focused: this.#focus,
			desktopSupported: this.#desktopNotify,
		});
		if (action === "none") return;
		this.#terminal.write(notificationSequence(action, message));
	}

	#onResize(): void {
		// 行会在新宽度下重排，旧的选区端点已经对不上
		this.#conversation.cancelSelection();
		this.#conversation.clearHover();
		// 先按记住的行数擦掉旧活动区，再按新宽度重画
		this.#region.clear();
		this.#refresh();
	}

	#startTicker(): void {
		this.#stopTicker();
		// 指示器要动起来，否则模型想十几秒的界面看起来像卡住了
		this.#ticker = setInterval(() => this.#refresh(), 120);
	}

	#stopTicker(): void {
		if (this.#ticker === undefined) return;
		clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	#setCursorVisible(visible: boolean): void {
		if (this.#cursorVisible === visible) return;
		this.#cursorVisible = visible;
		this.#terminal.setCursorVisible(visible);
	}

	/** 按行翻阅。视口按上一帧的内容行数与高度算边界。 */
	#scrollBy(delta: number): void {
		this.#conversation.scrollBy(delta);
		this.#refresh();
	}

	/** 按页翻阅，正数向下。 */
	#scrollPages(pages: number): void {
		this.#conversation.scrollPages(pages);
		this.#refresh();
	}

	/** 组装一帧：会话区（含可选的状态行）、审批面板或输入框、快捷键条。 */
	#refresh(): void {
		if (this.#stopped || this.#runtime === undefined) return;

		const size = this.#terminal.size();
		const body = this.#body(size.cols);
		const dialog = this.#dialog;
		const status = this.#running ? RUNNING_ROWS : 0;
		// 输入区最多占十几行：再高就把会话区挤没了，整帧还可能超过终端高度
		const maxEditorRows = Math.max(3, Math.min(12, size.rows - 12 - status));
		// 输入框是带左右边框的方框，正文宽度要扣掉边框和左右内边距
		const editor = this.#prompt.render(
			Math.max(1, size.cols - INPUT_CHROME),
			maxEditorRows,
			PASTE_BG,
			PROMPT,
		);
		const panel =
			dialog === undefined
				? undefined
				: panelRows(size.cols, dialog, this.#dialogFocus, this.#runtime?.cwd);
		const menu = panel === undefined ? this.#prompt.menuRows(size.cols, size.rows) : [];
		const editorRows = editor.lines.length + PROMPT_CHROME_ROWS;
		const footerRows = panel === undefined ? editorRows + menu.length : panel.length + 1;
		const height = Math.max(footerRows + status + 1, size.rows);
		const rows = Math.max(1, height - footerRows - status);

		const conversation = this.#conversation.conversationRows(body, rows);
		const input: readonly Line[] =
			panel === undefined
				? inputBoxRows({
						width: size.cols,
						editor,
						focused: this.#pane === "prompt",
						model: this.#runtime?.model ?? "",
						approval: this.#runtime?.approval ?? "",
					})
				: panel;
		this.#menuTopScreen = rows + status;
		this.#editorTop = rows + status + menu.length + 1;

		const lines: Line[] = [
			...conversation,
			...(this.#running ? [plain(""), runningRow(this.#activity, this.#turnStartedAt, size.cols)] : []),
			...menu,
			...input,
			this.#footerLine(size.cols),
		];

		// 审批面板没有硬件光标；输入框里光标位于边框与内边距之后
		this.#setCursorVisible(panel === undefined && this.#pane === "prompt");
		this.#region.draw({
			lines: this.#paintBackground(lines, size.cols),
			cursor:
				panel === undefined
					? {
							row: rows + status + menu.length + 1 + editor.cursor.row,
							col: INPUT_LEFT + editor.cursor.col,
						}
					: undefined,
		});
	}

	#footerLine(width: number): Line {
		return footerRow({
			width,
			notice: this.#notice,
			hints: footerHints({
				dialog: this.#dialog !== undefined,
				pane: this.#pane,
				menu: this.#prompt.menuKind(),
				running: this.#running,
				following: this.#conversation.window.following,
				editorEmpty: this.#prompt.editor.isEmpty,
			}),
		});
	}

	/** 整屏铺底色：没写背景的格子补上底色，行宽不足时一路铺到右缘。 */
	#paintBackground(lines: readonly Line[], width: number): readonly Line[] {
		return lines.map((line) =>
			padLine(mapLine(line, (style) => ({ ...style, background: style?.background ?? THEME.base })), width, {
				background: THEME.base,
			}),
		);
	}
}
