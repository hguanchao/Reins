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
import { BAD, PASTE_BG, THEME, USER } from "./theme.ts";
import { ansiLines } from "./ansi.ts";
import { queueRows } from "./queue-view.ts";
import { toastLine } from "./toast.ts";
import { topBarRow } from "./top-bar.ts";
import { viewerRows } from "./viewer.ts";
import { welcomeRows } from "./welcome.ts";

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

/** 顶部状态行固定占一行。 */
const TOP_BAR_ROWS = 1;

/** 跑起来时多出的两行：空行与回合状态行。 */
const RUNNING_ROWS = 2;

/** 滚轮一格翻几行。终端只报「上滚」「下滚」，格与行之间的换算由界面定。 */
const WHEEL_LINES = 3;

/** 退出要连按两次的时限：第一次只在提示行说明，第二次才真的退。 */
const QUIT_CONFIRM_MS = 1_000;

/** 清空草稿要连按两次的时限。比退出短：清空是可逆的，确认只是防手滑。 */
const CLEAR_CONFIRM_MS = 800;

/** 翻页键走整页：视口里的一步是半屏，翻两下才是一屏。Ctrl+U/D 才走半页。 */
const FULL_PAGE = 2;

const PROMPT: Line = styled("❯ ", USER);

/** 需要连按两次的动作。 */
type ConfirmAction = "clear" | "quit";

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
	/** 当前动作的起点：运行状态行拿它显示这一步已经跑了多久 */
	#activityStartedAt = 0;
	#running = false;
	/** 已经发出中止请求，正在等这一轮收尾 */
	#cancelling = false;
	/** 已经决定退出：队列不再续跑 */
	#exiting = false;
	/** 运行中提交的后续消息；这一轮结束后按顺序接着跑 */
	#queued: string[] = [];
	/** Ctrl+S 暂存的草稿；顶边框会标出来 */
	#stash: string | undefined;
	#abort: AbortController | undefined;
	#ticker: NodeJS.Timeout | undefined;
	#escapeTimer: NodeJS.Timeout | undefined;
	/** 完成闪烁过期后再画一帧，免得最后一帧停在绿色上。 */
	#flashTimer: NodeJS.Timeout | undefined;
	/** 合并高频重画用的延迟帧；一个事件风暴里只画最后一帧。 */
	#paintTimer: NodeJS.Timeout | undefined;
	/** 当前焦点在哪：输入框还是主区。 */
	#pane: "prompt" | "scrollback" = "prompt";
	/** 终端光标当前是否可见，避免每帧都写一次显隐序列。 */
	#cursorVisible = true;
	/** 拖动滚动条时，抓点离滑块顶端的行数。 */
	#scrollbarGrab: number | undefined;
	/** 输入框上边框在屏幕上的行号。 */
	#inputTop = 0;
	/** 输入正文在屏幕上的起始行。 */
	#editorTop = 0;
	/** 下拉在屏幕上的起始行；鼠标行号减它得到候选行。 */
	#menuTopScreen = 0;
	/** 顶部上下文占用条的列范围；指针停上去时换成进度条。 */
	#contextRange: { readonly from: number; readonly to: number } | undefined;
	#contextHover = false;
	/** 正在全屏查看的块与滚动位置。 */
	#viewer: { readonly blockId: number; scroll: number } | undefined;
	#viewerMaxScroll = 0;
	/** 运行状态行在屏幕上的行号与其中可点的按钮。 */
	#runningRow: number | undefined;
	#runningStop: { readonly from: number; readonly to: number } | undefined;
	#runningFollow: { readonly from: number; readonly to: number } | undefined;
	#runningHover: "stop" | "follow" | undefined;
	/** 底部临时提示（复制成功之类），过一会儿让回给快捷键条。 */
	#notice = "";
	#noticeTimer: NodeJS.Timeout | undefined;
	/** 正在等待第二次按键的动作；过期或换了动作就作废。 */
	#confirm: { action: ConfirmAction; at: number } | undefined;
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
		this.#conversation.loadHistory(runtime.session.history);
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
		if (this.#paintTimer !== undefined) clearTimeout(this.#paintTimer);
		this.#paintTimer = undefined;
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
			// 查看器是键盘模态：滚轮、翻页和关闭都归它，底层会话不再响应
			if (this.#viewer !== undefined) {
				this.#handleViewer(event);
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
					if (event.name === "escape") {
						// 拒绝这次请求，回合继续走：Esc 从不打断回合
						this.#answer(false);
						continue;
					}
			if (event.name === "ctrl-c") {
				// Ctrl+C 才是停掉这一轮的键：拒绝，并把这一轮也停掉
				this.#answer(false);
				this.#cancelTurn();
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
						if (this.#running) this.#cancelTurn();
						continue;
					}
					if (event.name === "ctrl-d") {
						// 主区里的 Ctrl+D 是半页向下；退出归输入框那边
						this.#scrollPages(1);
						continue;
					}
					if (event.name === "ctrl-u") {
						this.#scrollPages(-1);
						continue;
					}
					if (event.name === "newline") {
						// Ctrl+J：主区里向下一行（输入框那边它是换行）
						this.#scrollBy(1);
						continue;
					}
					if (event.name === "ctrl-k") {
						this.#scrollBy(-1);
						continue;
					}
					if (event.name === "escape") {
						// 先让选中与悬停让位，再走全局策略：Esc 不打断回合，也不切窗格
						this.#conversation.cancelSelection();
						this.#conversation.clearHover();
						this.#escape();
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
				if (event.type === "text") {
					// 空格不参与主区的字母命令：它把焦点还给输入框
					if (event.text === " ") {
						this.#pane = "prompt";
						this.#refresh();
						continue;
					}
					this.#handleScrollbackText(event.text);
				}
				continue;
			}

			if (event.type === "paste") {
				this.#prompt.insertPaste(event.text, false);
				continue;
			}
			if (event.type === "text") {
				this.#prompt.insertText(event.text);
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
				case "r":
					if (this.#conversation.toggleSelectedRaw()) this.#refresh();
					break;
				case "y":
					this.#copyBlock();
					break;
				case "Y":
					this.#copyBlockMeta();
					break;
				case "c":
					this.#copyBlockPrimary();
					break;
				case "v":
					this.#openViewer();
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
		/** 顶部状态行之外的屏幕行。 */
		const bodyRow = row - TOP_BAR_ROWS;
		/** 鼠标行落在内容行上时对应的行号；上下留白里没有内容。 */
		const contentRow = this.#conversation.toContentRow(bodyRow);

		// 表格与代码块下面的 [Copy …] 标签：按下即写入剪贴板
		if (event.button === "left" && event.action === "down") {
			const copy = this.#conversation.copyTextAt(bodyRow, col);
			if (copy !== undefined) {
				this.#writeClipboard(copy);
				return;
			}
		}

		if (event.action === "move") {
			const overContext =
				row === 0 &&
				this.#contextRange !== undefined &&
				col >= this.#contextRange.from &&
				col < this.#contextRange.to;
			let changed = false;
			if (overContext !== this.#contextHover) {
				this.#contextHover = overContext;
				changed = true;
			}

			// 运行行上的两个按钮：指针停上去才亮起来
			let runningHover: "stop" | "follow" | undefined;
			if (this.#runningRow === row) {
				if (this.#runningStop !== undefined && col >= this.#runningStop.from && col < this.#runningStop.to) {
					runningHover = "stop";
				} else if (
					this.#runningFollow !== undefined &&
					col >= this.#runningFollow.from &&
					col < this.#runningFollow.to
				) {
					runningHover = "follow";
				}
			}
			if (runningHover !== this.#runningHover) {
				this.#runningHover = runningHover;
				changed = true;
			}

			// 输入框上方的候选面板：悬停行亮一档，点击行为保持不变
			const menuHit = this.#prompt.menuIndexAt(row - this.#menuTopScreen);
			const menuHover = menuHit?.index;
			if (menuHover !== this.#prompt.menuHover) {
				this.#prompt.setMenuHover(menuHover);
				changed = true;
			}

			if (this.#conversation.hoverAt(bodyRow, col, cols)) changed = true;
			if (changed) this.#refresh();
			return;
		}

		// 选中框右上角的关闭按钮先认：它和顶部的跟随指示可能落在同一行留白里
		if (
			event.button === "left" &&
			event.action === "down" &&
			this.#conversation.selectionCloseAt(bodyRow, col, this.#entryWidth(cols))
		) {
			this.#conversation.clearSelectedBlock();
			this.#conversation.cancelSelection();
			this.#refresh();
			return;
		}

		// 留白里的跟随指示：点一下回到那一端
		if (event.button === "left" && event.action === "down") {
			const action = this.#conversation.padActionAt(bodyRow);
			if (action !== undefined) {
				if (action === "top") this.#conversation.toTop();
				else this.#conversation.toEnd();
				this.#refresh();
				return;
			}
		}

		if (
			event.button === "left" &&
			event.action === "down" &&
			col === cols - 1 &&
			contentRow !== undefined &&
			this.#conversation.scrollbarShown
		) {
			const grab = scrollbarGrabOffset(contentRow, this.#conversation.total, this.#conversation.height, this.#conversation.window.start);
			if (grab !== undefined) {
				this.#scrollbarGrab = grab;
				this.#scrollTo(scrollbarStart(contentRow, grab, this.#conversation.total, this.#conversation.height));
			}
			return;
		}

		if (event.action === "drag" && this.#scrollbarGrab !== undefined) {
			const target =
				contentRow ??
				Math.max(0, Math.min(this.#conversation.height - 1, bodyRow - this.#conversation.topPad));
			this.#scrollTo(scrollbarStart(target, this.#scrollbarGrab, this.#conversation.total, this.#conversation.height));
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
			contentRow !== undefined &&
			col >= cols - GUTTER_WIDTH &&
			col < cols - GUTTER_WIDTH + RAIL_WIDTH
		) {
			if (railWidth({ width: this.#body(cols), turns: this.#conversation.turns.length }) > 0) {
				const cells = railCells(this.#conversation.height, this.#conversation.turns, this.#conversation.window.start);
				const target = cells[contentRow]?.target;
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

		// 运行状态行上的按钮：中止本轮，或从历史里回到末尾
		if (event.button === "left" && event.action === "down" && this.#runningRow === row) {
			if (
				this.#runningStop !== undefined &&
				col >= this.#runningStop.from &&
				col < this.#runningStop.to
			) {
				this.#cancelTurn();
				return;
			}
			if (
				this.#runningFollow !== undefined &&
				col >= this.#runningFollow.from &&
				col < this.#runningFollow.to
			) {
				this.#conversation.toEnd();
				this.#refresh();
			}
			return;
		}

		// 点到输入区：焦点回到输入框；双击粘贴 chip 则把它展开
		if (event.button === "left" && event.action === "down" && row >= this.#inputTop) {
			this.#pane = "prompt";
			this.#handleEditorClick(row, col);
			this.#refresh();
			return;
		}

		if (event.button === "left" && event.action === "down") {
			const result = this.#conversation.clickBlock(bodyRow);
			if (result !== "none") this.#pane = "scrollback";

			const point = this.#conversation.selectionPoint(col, bodyRow, this.#entryWidth(cols));
			if (point !== undefined) this.#conversation.beginSelection(point);
			if (result !== "none" || point !== undefined) this.#refresh();
			return;
		}

		if (event.action === "drag") {
			const point = this.#conversation.selectionPoint(col, bodyRow, this.#entryWidth(cols));
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

	/** 只复制工具的主参数：路径、命令或查询。 */
	#copyBlockPrimary(): void {
		if (this.#conversation.selectedBlockId === undefined) return;
		const text = this.#conversation.blockPrimary(this.#conversation.selectedBlockId);
		if (text !== undefined && text.length > 0) this.#writeClipboard(text);
	}

	/** 打开选中块的全屏查看器。 */
	#openViewer(): void {
		const id = this.#conversation.selectedBlockId;
		if (id === undefined) return;
		const text = this.#conversation.blockText(id);
		if (text === undefined || text.length === 0) return;
		this.#viewer = { blockId: id, scroll: 0 };
		this.#refresh();
	}

	#closeViewer(): void {
		this.#viewer = undefined;
		this.#refresh();
	}

	/** 查看器只认滚动与关闭；其他按键一律吞掉，避免改到下面的会话。 */
	#handleViewer(event: KeyEvent): void {
		if (event.type === "wheel") {
			this.#scrollViewer(event.direction === "up" ? -WHEEL_LINES : WHEEL_LINES);
			return;
		}
		if (event.type === "key") {
			switch (event.name) {
				case "escape":
				case "ctrl-c":
					this.#closeViewer();
					return;
				case "up":
				case "ctrl-p":
					this.#scrollViewer(-1);
					return;
				case "down":
				case "ctrl-n":
					this.#scrollViewer(1);
					return;
				case "pageup":
				case "ctrl-u":
					this.#scrollViewer(-10);
					return;
				case "pagedown":
				case "ctrl-d":
					this.#scrollViewer(10);
					return;
				case "home":
					this.#scrollViewer(-this.#viewerMaxScroll);
					return;
				case "end":
					this.#scrollViewer(this.#viewerMaxScroll);
					return;
				default:
					return;
			}
		}
		if (event.type !== "text") return;
		for (const char of event.text) {
			if (char === "q" || char === "v") {
				this.#closeViewer();
				return;
			}
			if (char === "j") this.#scrollViewer(1);
			else if (char === "k") this.#scrollViewer(-1);
			else if (char === "g") this.#scrollViewer(-this.#viewerMaxScroll);
			else if (char === "G") this.#scrollViewer(this.#viewerMaxScroll);
		}
	}

	#scrollViewer(delta: number): void {
		const viewer = this.#viewer;
		if (viewer === undefined || delta === 0) return;
		viewer.scroll = Math.max(0, Math.min(this.#viewerMaxScroll, viewer.scroll + delta));
		this.#refresh();
	}

	#viewerTitle(): string {
		const viewer = this.#viewer;
		if (viewer === undefined) return "View";
		const kind = this.#conversation.blocks.find((block) => block.id === viewer.blockId)?.kind;
		const label =
			kind === "agent"
				? "Answer"
				: kind === "thinking"
					? "Thought"
					: kind === "user"
						? "Prompt"
						: kind === "group"
							? "Tools"
							: "Output";
		const meta = this.#conversation.blockMeta(viewer.blockId)?.split("\n")[0]?.trim();
		return meta === undefined || meta.length === 0 ? label : `${label} · ${meta}`;
	}

	#viewerText(): string {
		const viewer = this.#viewer;
		return viewer === undefined ? "" : (this.#conversation.blockText(viewer.blockId) ?? "");
	}

	/**
	 * 暂存/取回草稿。
	 *
	 * 有草稿时存起来并清空输入框；输入框为空且存在暂存时放回去。暂存只留在内存里，
	 * 退出后不再恢复。
	 */
	#toggleStash(): void {
		if (!this.#prompt.editor.isEmpty) {
			this.#stash = this.#prompt.editor.text;
			this.#prompt.editor.clear();
			this.#showNotice("Draft stashed · Ctrl+S to restore");
			this.#refresh();
			return;
		}
		const stashed = this.#stash;
		if (stashed === undefined) return;
		this.#stash = undefined;
		this.#prompt.insertText(stashed);
		this.#showNotice("Draft restored");
		this.#refresh();
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
	 * 装弹一次要连按的动作：提示行改成「再按一次做什么」，时限内的第二次才真的执行。
	 *
	 * 退出与清空草稿都是按错代价不小的动作，第一次按只用来表明意图。
	 */
	#armConfirm(action: ConfirmAction, label: string, ttl: number): void {
		this.#confirm = { action, at: Date.now() };
		this.#showNotice(`press again to ${label}`, ttl);
	}

	/** 时限内的第二次按键：认领这次动作；过期或不是同一个动作都当作没按过。 */
	#claimConfirm(action: ConfirmAction, ttl: number): boolean {
		const pending = this.#confirm;
		if (pending === undefined || pending.action !== action || Date.now() - pending.at > ttl) {
			return false;
		}
		this.#confirm = undefined;
		return true;
	}

	/**
	 * Esc。
	 *
	 * 它从不打断回合——那是 Ctrl+C 的职责，按了 Esc 只把这句话写在提示行上。有草稿时连按两次
	 * 才清空：一次就抹掉长草稿太容易出事，而空输入框没什么可清的，直接吞掉。
	 */
	#escape(): void {
		if (this.#running) {
			this.#showNotice("Press Ctrl+C to cancel the turn");
			return;
		}
		if (this.#prompt.editor.isEmpty) return;
		if (this.#claimConfirm("clear", CLEAR_CONFIRM_MS)) {
			this.#prompt.editor.clear();
			this.#refresh();
			return;
		}
		this.#armConfirm("clear", "clear", CLEAR_CONFIRM_MS);
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
				this.#scrollPages(-FULL_PAGE);
				return true;
			case "pagedown":
				this.#scrollPages(FULL_PAGE);
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
			case "ctrl-s":
				this.#toggleStash();
				return;
			case "ctrl-v":
				this.#pasteFromClipboard(false);
				return;
			case "ctrl-shift-v":
				this.#pasteFromClipboard(true);
				return;
			case "newline":
				this.#prompt.insertText("\n");
				break;
			case "up":
				if (this.#prompt.editor.isEmpty) {
					if (!this.#prompt.openHistory()) this.#prompt.editor.historyPrev();
				} else {
					this.#prompt.editor.moveUp();
				}
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
				// 有草稿先清草稿：手滑按到 Ctrl+C 不该把整轮对话停掉
				if (!this.#prompt.editor.isEmpty) {
					this.#prompt.editor.clear();
					break;
				}
				if (this.#running) this.#cancelTurn();
				// 空闲且空输入：什么都不做——退出是 Ctrl+D，而且要连按两次
				return;
			case "escape":
				this.#escape();
				return;
			case "ctrl-d":
			case "ctrl-q":
				if (this.#claimConfirm("quit", QUIT_CONFIRM_MS)) {
					this.#exit();
					return;
				}
				this.#armConfirm("quit", "quit", QUIT_CONFIRM_MS);
				return;
			default:
				// 其余按键目前没有绑定，按了就当没按
				return;
		}
		this.#refresh();
	}

	async #submit(): Promise<void> {
		if (this.#runtime === undefined) return;

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

		// 一轮还没结束时提交的内容进入队列，不打断当前回合
		if (this.#running) {
			this.#queued.push(text);
			this.#refresh();
			return;
		}

		await this.#runSubmitted(text);
	}

	/** 真正开一项工作：普通消息进入回合，斜杠命令直接执行。 */
	async #runSubmitted(text: string): Promise<void> {
		const runtime = this.#runtime;
		if (runtime === undefined) return;

		// 新回合从这一行开始；轨道多一格刻度，画面回到末尾——接下来要看的就是它的结果
		this.#pane = "prompt";
		this.#conversation.userTurn(text);
		this.#conversation.toEnd();
		this.#refresh();

		if (text.startsWith("/")) {
			await this.#runCommand(text.slice(1));
			this.#drainQueue();
			return;
		}

		await this.#runTurn(runtime, text);
	}

	/** 这一轮结束后接着跑队列里的下一条；没有就什么都不做。 */
	#drainQueue(): void {
		if (this.#running || this.#stopped || this.#exiting) return;
		const next = this.#queued.shift();
		if (next === undefined) return;
		void this.#runSubmitted(next);
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
			// 插件命令可能带着自己的颜色；按 SGR 还原，别让转义序列直接写进终端
			this.#conversation.appendSystem(
				lines.flatMap((line) => ansiLines(line, { color: THEME.text })),
			);
			this.#refresh();
		} catch (error) {
			// 命令出错只影响这一条命令，界面继续用
			this.#conversation.appendSystem([styled(error instanceof Error ? error.message : String(error), BAD)], BAD);
			this.#refresh();
		}
	}

	async #runTurn(runtime: InteractiveRuntime, prompt: string): Promise<void> {
		this.#running = true;
		this.#runningHover = undefined;
		this.#turnStartedAt = Date.now();
		this.#setActivity("Thinking…", this.#turnStartedAt);
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
			this.#cancelling = false;
			this.#runningHover = undefined;
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
			this.#drainQueue();
		}
	}

	#onAgentEvent(event: AgentEvent): void {
		const now = Date.now();
		switch (event.type) {
			case "turn_start":
				this.#setActivity("Thinking…", now);
				break;
			case "reasoning_delta":
				this.#setActivity("Thinking…", now);
				break;
			case "text_delta":
				// 开始往外写答案：与还在想要分开，两者的等待感受完全不同
				this.#setActivity("Responding…", now);
				break;
			case "tool_start":
				this.#setActivity(`Running ${event.name}`, now);
				break;
			case "tool_end":
				this.#setActivity("Thinking…", now);
				break;
			case "compaction_start":
				this.#setActivity("Compacting…", now);
				break;
			case "compaction_end":
			case "compaction_failed":
				this.#setActivity("Thinking…", now);
				break;
			default:
				break;
		}

		this.#conversation.handle(event, now);
		this.#requestRefresh();

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

	/**
	 * 合并高频重画：流式输出的增量会在极短的时间窗里连发多个事件，若每个都立刻整帧重画，
	 * 画面追不上字节就闪。排一个 0ms 的延迟帧，风暴里的中间态统统跳过，只画最后一帧。
	 */
	#requestRefresh(): void {
		if (this.#stopped || this.#paintTimer !== undefined) return;
		this.#paintTimer = setTimeout(() => {
			this.#paintTimer = undefined;
			this.#refresh();
		}, 0);
	}

	/** 完成闪烁只持续几百毫秒，安静下来后也要再画一帧把它落回静态色。 */
	#scheduleFlashRefresh(): void {
		if (this.#flashTimer !== undefined) clearTimeout(this.#flashTimer);
		this.#flashTimer = setTimeout(() => {
			this.#flashTimer = undefined;
			this.#refresh();
		}, 500);
	}

	/** 中止当前回合。只发一次请求，重复按不会叠加。 */
	#cancelTurn(): void {
		if (this.#abort === undefined || this.#cancelling) return;
		this.#cancelling = true;
		this.#abort.abort();
		this.#refresh();
	}

	#exit(): void {
		this.#exiting = true;
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
		this.#contextHover = false;
		this.#contextRange = undefined;
		// 先按记住的行数擦掉旧活动区，再按新宽度重画
		this.#region.clear();
		this.#refresh();
	}

	#startTicker(): void {
		this.#stopTicker();
		// 指示器要动起来，否则模型想十几秒的界面看起来像卡住了。
		// 定时器不该单独把进程拖住：界面退出或测试提前失败时，挂在这里的就是它。
		this.#ticker = setInterval(() => this.#refresh(), 120);
		this.#ticker.unref();
	}

	#stopTicker(): void {
		if (this.#ticker === undefined) return;
		clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	/** 换一个动作。同一个动作接连上报不算换，阶段计时不该被重复的上报清零。 */
	#setActivity(text: string, at: number): void {
		if (this.#activity === text) return;
		this.#activity = text;
		this.#activityStartedAt = at;
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
		const focused = this.#pane === "prompt";
		// 输入区最多占十几行：再高就把会话区挤没了，整帧还可能超过终端高度
		const maxEditorRows = Math.max(3, Math.min(12, size.rows - 12 - status));
		// 输入框是带左右边框的方框，正文宽度要扣掉边框和左右内边距。
		// 失焦时只留一行：焦点在主区，输入框只是还看得见的草稿，不该继续占高度。
		const editor = this.#prompt.render(
			Math.max(1, size.cols - INPUT_CHROME),
			focused ? maxEditorRows : 1,
			PASTE_BG,
			PROMPT,
			focused ? undefined : "Build anything",
		);
		const panel =
			dialog === undefined
				? undefined
				: panelRows(size.cols, dialog, this.#dialogFocus, this.#runtime?.cwd);
		const menu = panel === undefined ? this.#prompt.menuRows(size.cols, size.rows) : [];
		const queue = queueRows(this.#queued, size.cols);
		const editorRows = editor.lines.length + PROMPT_CHROME_ROWS;
		const footerRows = panel === undefined ? editorRows + menu.length : panel.length + 1;
		const height = Math.max(footerRows + status + TOP_BAR_ROWS + queue.length + 1, size.rows);
		const rows = Math.max(1, height - footerRows - status - TOP_BAR_ROWS - queue.length);

		const conversation = this.#conversation.conversationRows(
			body,
			rows,
			this.#pane === "scrollback",
		);
		const viewer =
			this.#viewer === undefined
				? undefined
				: viewerRows({
						width: size.cols,
						rows,
						title: this.#viewerTitle(),
						text: this.#viewerText(),
						scroll: this.#viewer.scroll,
					});
		if (viewer !== undefined && this.#viewer !== undefined) {
			this.#viewerMaxScroll = viewer.maxScroll;
			this.#viewer.scroll = Math.max(0, Math.min(viewer.maxScroll, this.#viewer.scroll));
		}
		// 查看器盖住会话区；没有查看器时，空会话让给入口卡片
		const bodyLines =
			viewer?.lines ??
			(this.#conversation.isEmpty ? welcomeRows({ width: size.cols, rows }) : conversation);
		const input: readonly Line[] =
			panel === undefined
				? inputBoxRows({
						width: size.cols,
						editor,
						focused,
						model: this.#runtime?.model ?? "",
						approval: this.#runtime?.approval ?? "",
						multiline: this.#prompt.editor.text.includes("\n"),
						caption: this.#stash === undefined ? undefined : "Stashed",
					})
				: panel;
		const usedTokens = this.#runtime?.contextTokens() ?? 0;
		const top = topBarRow({
			width: size.cols,
			branch: this.#runtime?.branch,
			cwd: this.#runtime?.cwd ?? "",
			sandbox: this.#runtime?.sandbox ?? "off",
			used: usedTokens,
			total: this.#runtime?.contextWindow,
			hover: this.#contextHover,
		});
		this.#contextRange = top.context;
		this.#menuTopScreen = TOP_BAR_ROWS + rows + queue.length + status;
		this.#inputTop = this.#menuTopScreen + menu.length;
		this.#editorTop = this.#inputTop + 1;

		const running = this.#running
			? runningRow({
					activity: this.#activity,
					startedAt: this.#turnStartedAt,
					phaseStartedAt: this.#activityStartedAt,
					tokens: usedTokens,
					width: size.cols,
					following: this.#conversation.window.following,
					cancelling: this.#cancelling,
					queued: this.#queued.length,
					stopHover: this.#runningHover === "stop",
					followHover: this.#runningHover === "follow",
				})
			: undefined;
		this.#runningRow = running === undefined ? undefined : TOP_BAR_ROWS + rows + queue.length + 1;
		this.#runningStop = running?.stop;
		this.#runningFollow = running?.follow;

		const lines: Line[] = [
			top.line,
			...bodyLines,
			...queue,
			...(running === undefined ? [] : [plain(""), running.line]),
			...menu,
			...input,
			this.#footerLine(size.cols),
		];

		// 临时提示盖在会话区最后一行右端；查看器的底边框不盖
		if (this.#notice.length > 0 && viewer === undefined) {
			const toastRow = TOP_BAR_ROWS + rows - 1;
			if (toastRow >= 0 && toastRow < lines.length) {
				lines[toastRow] = toastLine(lines[toastRow] ?? [], size.cols, this.#notice);
			}
		}

		// 审批面板与查看器没有硬件光标；输入框里光标位于边框与内边距之后
		this.#setCursorVisible(panel === undefined && this.#pane === "prompt" && this.#viewer === undefined);
		this.#region.draw({
			lines: this.#paintBackground(lines, size.cols),
			cursor:
				panel === undefined
					? {
							row: this.#editorTop + editor.cursor.row,
							col: INPUT_LEFT + editor.cursor.col,
						}
					: undefined,
		});
	}

	#footerLine(width: number): Line {
		return footerRow({
			width,
			hints: footerHints({
				dialog: this.#dialog !== undefined,
				viewer: this.#viewer !== undefined,
				pane: this.#pane,
				menu: this.#prompt.menuKind(),
				running: this.#running,
				following: this.#conversation.window.following,
				editorEmpty: this.#prompt.editor.isEmpty,
				hasStash: this.#stash !== undefined,
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
