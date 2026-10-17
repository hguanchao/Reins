import type { AgentEvent } from "../../agent/events.ts";
import type { NotifyMode } from "../../config/config-file.ts";
import {
	alignEnds,
	colorSupport,
	concat,
	formatDuration,
	KeyDecoder,
	LineEditor,
	padLine,
	plain,
	ScreenRegion,
	spinnerFrame,
	styled,
	truncateLine,
	Viewport,
	wrapLine,
	type KeyEvent,
	type Line,
	type Span,
	type Terminal,
	type ViewportWindow,
} from "../../tui/index.ts";
import type { InteractiveFrontend, InteractiveRuntime } from "../../tui/frontend.ts";
import { isBuiltinCommand, runBuiltin } from "./commands.ts";
import { DIALOG_OPTIONS, dialogDecision, type ConfirmDialog } from "./dialog.ts";
import { decideNotify, desktopNotificationsSupported, notificationSequence } from "./notify.ts";
import { appendRail, railCells, railWidth } from "./rail.ts";
import { ACCENT, BAD, BRIGHT, DIM, FAINT, TEXT, TITLE, WARN } from "./theme.ts";
import { Transcript } from "./transcript.ts";

/**
 * 交互式界面。
 *
 * 界面运行在终端的备用屏里，整块屏幕都归它，从上到下四段：顶部状态行、会话区（右侧一格一回合
 * 的轨道）、输入框、快捷键条。一句话都没说之前，会话区摆的是入口框——首屏。
 *
 * 备用屏没有终端自带的回滚缓冲，回看历史因此由会话区自己滚动：PageUp/PageDown 翻页，
 * Ctrl+P/Ctrl+N 逐行，滚轮向上向下，翻阅时 Home/End 跳到首尾。翻阅期间新到的内容不会把画面
 * 推走——视口记的是内容里的绝对行号，而流式输出只往末尾加行；只有发出新的一句时才回到末尾。
 *
 * 界面接管终端期间，按键全部由这里解释，因此 Ctrl+C 不再产生信号：它与 Esc 一起用来中止
 * 当前这一轮；空闲时它们清空输入，输入为空时 Ctrl+C 才退出。退出前必须把备用屏交还、
 * 终端恢复原状——留在原始模式里，使用者的 shell 会连回显都没有。
 */

/** 会话区与确认卡片左侧留两列：整屏贴边会把内容顶到终端边缘上，读起来很挤。 */
const PAD = 2;

/** 输入框之外的固定行：上面一行空行、边框上下两条、下面的快捷键条。 */
const PROMPT_CHROME_ROWS = 4;

/** 跑起来时多出的两行：空行与回合状态行。 */
const RUNNING_ROWS = 2;

/** 审批弹窗的最大宽度，以及它与内容区两侧之间至少留出的空白。 */
const DIALOG_MAX_WIDTH = 56;
const DIALOG_MARGIN = 8;

/** 滚轮一格翻几行。终端只报「上滚」「下滚」，格与行之间的换算由界面定。 */
const WHEEL_LINES = 3;

const PROMPT: Line = styled("› ", ACCENT);
const PLACEHOLDER = "Build anything";

/** 输入框的上下边框：细线铺满整行宽，颜色用正文白。 */
const boxRule = (width: number): Line => styled("─".repeat(Math.max(0, width)), TEXT);

/** 主区上一次画出来的样子。翻阅按键与轨道按它算边界。 */
interface MainFrame {
	/** 主区内容的总行数：已提交的历史加活动块 */
	readonly total: number;
	/** 主区高度 */
	readonly rows: number;
	readonly window: ViewportWindow;
}

/** 底部快捷键条上的一条：键与动作。 */
interface KeyHint {
	readonly keys: string;
	readonly label: string;
}

export interface FrontendOptions {
	readonly terminal: Terminal;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export class TerminalFrontend implements InteractiveFrontend {
	readonly #terminal: Terminal;
	readonly #region: ScreenRegion;
	readonly #desktopNotify: boolean;
	readonly #editor = new LineEditor();
	readonly #keys = new KeyDecoder();
	readonly #transcript: Transcript;
	/** 会话的全部行。备用屏没有终端自带的回滚缓冲，回看历史靠会话区自己滚动。 */
	readonly #history: Line[] = [];
	/** 用户消息块占用的行号：它们贴住屏幕左边，不加全局内边距，也不接轨道。 */
	readonly #userLines = new Set<number>();
	/** 每个回合起始的行号。右侧轨道一格刻度就是一个回合。 */
	readonly #turns: number[] = [];
	readonly #viewport = new Viewport();
	#main: MainFrame = { total: 0, rows: 1, window: { start: 0, following: true } };

	#runtime: InteractiveRuntime | undefined;
	#dialog: ConfirmDialog | undefined;
	#focus: boolean | undefined;
	#notifyMode: NotifyMode = "auto";
	#activity = "";
	#running = false;
	#abort: AbortController | undefined;
	#ticker: NodeJS.Timeout | undefined;
	#escapeTimer: NodeJS.Timeout | undefined;
	/** 本轮开始的时刻。事件里没有耗时，指示器按它算「这一轮跑了多久」。 */
	#turnStartedAt = 0;
	#done: (() => void) | undefined;
	/** 终端已经交还，此后不再往屏幕上写任何东西 */
	#stopped = false;

	constructor(options: FrontendOptions) {
		this.#terminal = options.terminal;
		this.#region = new ScreenRegion(options.terminal, { colors: colorSupport(options.env) });
		this.#desktopNotify = desktopNotificationsSupported(options.env);
		this.#transcript = new Transcript(this.#body(options.terminal.size().cols));
	}

	async run(runtime: InteractiveRuntime): Promise<void> {
		this.#runtime = runtime;
		this.#notifyMode = runtime.notify;
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
		return Math.max(16, cols - PAD);
	}

	#startTerminal(): void {
		this.#terminal.setRawMode(true);
		this.#terminal.setBracketedPaste(true);
		this.#terminal.setFocusReporting(true);
		// 滚轮在备用屏里没有别的东西可滚：只有终端把它报上来，会话区才翻得动。代价是鼠标不再
		// 由终端选中（选中文本要按住 Shift），所以只在这一段运行期间开着
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
		this.#terminal.setAlternateScreen(false);
		this.#terminal.setMouseTracking(false);
		this.#terminal.setBracketedPaste(false);
		this.#terminal.setFocusReporting(false);
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
				this.#scrollBy(event.direction === "up" ? -WHEEL_LINES : WHEEL_LINES);
				continue;
			}
			// 翻阅在任何时候都要能用：确认卡片问的就是上面那次工具调用，得能翻上去看清楚
			if (event.type === "key" && this.#scrollKey(event)) continue;

			if (this.#dialog !== undefined) {
				if (event.type === "key" && event.name === "ctrl-c") {
					// 询问期间按 Ctrl+C：既拒绝，也把这一轮停掉
					this.#interrupt(true);
					continue;
				}
				const decision = dialogDecision(event);
				if (decision !== undefined) this.#answer(decision);
				continue;
			}
			if (event.type === "paste" || event.type === "text") {
				this.#editor.insert(event.text);
				this.#refresh();
				continue;
			}
			this.#handleKey(event);
		}
	}

	/**
	 * 翻阅会话的按键。用掉了返回 true。
	 *
	 * Home/End 在跟尾时属于输入框（行首行尾），只有正翻阅历史时才是「跳到最早/回到末尾」：
	 * 那时候使用者的注意力在历史里，不在输入框上。
	 */
	#scrollKey(event: Extract<KeyEvent, { type: "key" }>): boolean {
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
				if (this.#main.window.following) return false;
				this.#viewport.toTop();
				this.#refresh();
				return true;
			case "end":
				if (this.#main.window.following) return false;
				this.#viewport.toEnd();
				this.#refresh();
				return true;
			default:
				return false;
		}
	}

	#handleKey(event: Extract<KeyEvent, { type: "key" }>): void {
		switch (event.name) {
			case "enter":
				void this.#submit();
				return;
			case "backspace":
				this.#editor.backspace();
				break;
			case "delete":
				this.#editor.deleteForward();
				break;
			case "left":
				this.#editor.moveLeft();
				break;
			case "right":
				this.#editor.moveRight();
				break;
			case "home":
			case "ctrl-a":
				this.#editor.moveHome();
				break;
			case "end":
			case "ctrl-e":
				this.#editor.moveEnd();
				break;
			case "ctrl-u":
				this.#editor.deleteToStart();
				break;
			case "ctrl-k":
				this.#editor.deleteToEnd();
				break;
			case "ctrl-w":
				this.#editor.deleteWordBefore();
				break;
			case "up":
				this.#editor.historyPrev();
				break;
			case "down":
				this.#editor.historyNext();
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
				if (this.#editor.isEmpty && !this.#running) this.#exit();
				return;
			default:
				// tab 等目前没有绑定，按了就当没按
				return;
		}
		this.#refresh();
	}

	async #submit(): Promise<void> {
		const runtime = this.#runtime;
		if (runtime === undefined) return;

		if (this.#running) {
			this.#commit([styled("A turn is still running; wait for it to finish, or press Esc or Ctrl+C to cancel.", WARN)]);
			return;
		}

		const text = this.#editor.submit();
		if (text.trim().length === 0) {
			this.#refresh();
			return;
		}

		// 新回合从这一行开始；轨道多一格刻度，画面回到末尾——接下来要看的就是它的结果
		this.#turns.push(this.#history.length);
		this.#viewport.toEnd();
		// 用户消息块按整屏宽排版，并通过记录行号跳过全局内边距与轨道
		const userLines = this.#transcript.userTurn(text, Math.max(1, this.#terminal.size().cols));
		const userStart = this.#history.length;
		for (let index = 0; index < userLines.length; index += 1) this.#userLines.add(userStart + index);
		this.#commit(userLines);

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
				this.#commit(result.lines);
				if (result.exit === true) {
					this.#exit();
					return;
				}
				return;
			}

			const lines = await runtime.runCommand(name, args);
			this.#commit(lines.map((line) => plain(line)));
		} catch (error) {
			// 命令出错只影响这一条命令，界面继续用
			this.#commit([styled(error instanceof Error ? error.message : String(error), BAD)]);
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
			this.#commit([styled(`✗ Error: ${error instanceof Error ? error.message : String(error)}`, BAD)]);
		} finally {
			this.#running = false;
			this.#abort = undefined;
			this.#activity = "";
			this.#stopTicker();
			this.#transcript.clearRunning();
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

		this.#commit(this.#transcript.handle(event, now));
		this.#refresh();
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
		if (!this.#editor.isEmpty) {
			this.#editor.clear();
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
		return new Promise<boolean>((resolve) => {
			this.#dialog = { question, detail, resolve };
			this.#refresh();
			// 屏幕前的这个人可能正看着别的窗口，这一问必须让他知道
			this.#notify(question);
		});
	}

	#answer(allowed: boolean): void {
		const dialog = this.#dialog;
		if (dialog === undefined) return;
		this.#dialog = undefined;
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

	#commit(lines: readonly Line[]): void {
		if (lines.length === 0) return;
		// 只往末尾加行：正翻阅历史时窗口因此不会被新内容推走
		this.#history.push(...lines);
		this.#refresh();
	}

	/** 按行翻阅。视口按上一帧的内容行数与高度算边界。 */
	#scrollBy(delta: number): void {
		this.#viewport.scrollBy(delta, this.#main.total, this.#main.rows);
		this.#refresh();
	}

	/** 按页翻阅，正数向下。 */
	#scrollPages(pages: number): void {
		this.#viewport.scrollPages(pages, this.#main.total, this.#main.rows);
		this.#refresh();
	}

	/** 组装一帧：会话区（含可选的状态行与确认卡片）、输入框、快捷键条。 */
	#refresh(): void {
		if (this.#stopped || this.#runtime === undefined) return;

		const size = this.#terminal.size();
		const body = this.#body(size.cols);
		// 输入框没有左右边框，正文从第一列开始排，占满整行；它多高先算出来，会话区才好分剩下的行
		const editor = this.#editor.render({ width: size.cols, prompt: PROMPT, placeholder: PLACEHOLDER });
		const footerRows = editor.lines.length + PROMPT_CHROME_ROWS;
		const dialog = this.#dialog;
		const status = this.#running ? RUNNING_ROWS : 0;
		// 弹窗盖在会话区上，不再额外占行；这里只要保证至少剩下一行会话
		const height = Math.max(footerRows + status + 1, size.rows);
		const rows = Math.max(1, height - footerRows - status);

		const conversation = this.#conversationRows(body, rows, dialog);

		const lines: Line[] = [
			...conversation,
			...(this.#running ? [plain(""), this.#runningRow(size.cols)] : []),
			plain(""),
			boxRule(size.cols),
			...editor.lines,
			this.#boxBottom(size.cols),
			this.#keysRow(size.cols),
		];

		// 光标在输入框里：它上面是会话区与输入框的上边框和留白
		this.#region.draw({
			lines,
			cursor: {
				row: rows + status + 2 + editor.cursor.row,
				col: editor.cursor.col,
			},
		});
	}

	/** 主屏：会话区的可见窗口，右侧一列轨道；有审批时把弹窗盖在中间。 */
	#conversationRows(body: number, rows: number, dialog: ConfirmDialog | undefined): readonly Line[] {
		const mainRows = Math.max(1, rows);
		const rail = railWidth({ width: body, turns: this.#turns.length });
		// 轨道占走的列要让出来：正文按扣掉轨道之后的宽度重排
		this.#transcript.resize(Math.max(1, body - rail));

		// 活动块按主区高度折行：一屏装不下的部分只留最近的，它才是「还在动的」那几行
		const now = Date.now();
		const live = this.#transcript.live({ maxLines: mainRows, now });
		const content = [...this.#history, ...live];
		const window = this.#viewport.window(content.length, mainRows);
		this.#main = { total: content.length, rows: mainRows, window };

		const visible = content.slice(window.start, window.start + mainRows);
		while (visible.length < mainRows) visible.push(plain(""));

		// 每一行末尾接一格轨道：从上往下就是会话的顺序。用户消息块自己占满整行，不再加边距与轨道
		const cells = railCells(mainRows, this.#turns, window.start);
		const conversation = visible.map((line, index) => {
			if (this.#userLines.has(window.start + index)) return line;
			return rail === 0
				? concat(plain(" ".repeat(PAD)), line)
				: concat(plain(" ".repeat(PAD)), appendRail(line, cells[index]));
		});

		if (dialog === undefined) return conversation;
		return this.#overlayDialog(conversation, dialog, body);
	}

	/** 把审批弹窗盖在会话区正中：弹窗自己占的行替换掉背后的内容。 */
	#overlayDialog(conversation: readonly Line[], dialog: ConfirmDialog, body: number): readonly Line[] {
		const popup = this.#dialogRows(dialog, body, conversation.length);
		const top = Math.max(0, Math.floor((conversation.length - popup.length) / 2));
		return conversation.map((line, index) => {
			const popupLine = popup[index - top];
			return popupLine === undefined ? line : concat(plain(" ".repeat(PAD)), popupLine);
		});
	}

	/** 弹窗本体：标题嵌在上边框里，下面是问句、调用详情和横排的两个选项。 */
	#dialogRows(dialog: ConfirmDialog, body: number, rows: number): readonly Line[] {
		const width = Math.min(body, Math.max(24, Math.min(DIALOG_MAX_WIDTH, body - DIALOG_MARGIN * 2)));
		const inner = Math.max(1, width - 2);
		const left = Math.max(0, Math.floor((body - width) / 2));
		const [allow, deny] = DIALOG_OPTIONS;

		const title = " Approval required ";
		const header = concat(
			styled("╭─", FAINT),
			styled(title, TITLE),
			styled(`${"─".repeat(Math.max(0, width - 3 - title.length))}╮`, FAINT),
		);
		const footer = styled(`╰${"─".repeat(Math.max(0, width - 2))}╯`, FAINT);
		const row = (content: Line): Line => concat(styled("│", FAINT), padLine(content, inner), styled("│", FAINT));

		// 详情可能很长；弹窗最多占满整个会话区，超出部分由换行器加省略号
		const detailWidth = inner;
		const detail = wrapLine(styled(dialog.detail, DIM), {
			width: detailWidth,
			firstIndent: concat(plain("  "), styled("┃ ", ACCENT)),
			restIndent: concat(plain("  "), styled("┃ ", ACCENT)),
			maxLines: Math.max(1, rows - 6),
		});
		const options = concat(
			styled(`▶ ${allow.key}  ${allow.label}`, ACCENT),
			plain("      "),
			styled(`${deny.key}  ${deny.label}`, DIM),
		);

		const lines: Line[] = [
			header,
			row(plain("")),
			row(concat(plain("  "), truncateLine(styled(dialog.question, TITLE), Math.max(1, inner - 2)))),
			...detail.map(row),
			row(plain("")),
			row(concat(plain("  "), truncateLine(options, Math.max(1, inner - 2)))),
			footer,
		];
		return lines.map((line) => concat(plain(" ".repeat(left)), line));
	}

	/** 跑起来时的那一行：左边是当前动作，右边是这一轮已经跑了多久。 */
	#runningRow(width: number): Line {
		const elapsed = Date.now() - this.#turnStartedAt;
		const head = concat(styled(`${spinnerFrame(elapsed)} `, ACCENT), styled(this.#activity, TEXT));
		return alignEnds(head, styled(formatDuration(elapsed), DIM), width);
	}

	/** 输入框的下边框：与上边框同一条细线，铺满整个终端宽。 */
	#boxBottom(cols: number): Line {
		return boxRule(cols);
	}

	/** 底部快捷键条：当前场景该按什么。 */
	#keysRow(width: number): Line {
		return this.#hintLine(this.#hints(), width);
	}

	/** 一行按键提示：键亮、动作暗，段与段之间用竖线分开。 */
	#hintLine(hints: readonly KeyHint[], width: number): Line {
		const parts: Span[] = [];
		hints.forEach((hint, index) => {
			if (index > 0) parts.push(...styled("  │  ", FAINT));
			parts.push(...styled(hint.keys, { color: BRIGHT.color, bold: true }));
			parts.push(...styled(`:${hint.label}`, DIM));
		});
		return truncateLine(parts, width);
	}

	/**
	 * 当前该显示哪几条按键。
	 *
	 * 正翻阅时先说怎么翻，跑着的时候先说怎么停：这三处是使用者当下最可能要按的东西，
	 * 其余按键在 /help 里一次看全。
	 */
	#hints(): readonly KeyHint[] {
		const help: KeyHint = { keys: "/help", label: "shortcuts" };
		if (!this.#main.window.following) {
			return [
				{ keys: "PageUp/PageDown", label: "page" },
				{ keys: "Ctrl+P/N", label: "line" },
				{ keys: "End", label: "bottom" },
				help,
			];
		}
		if (this.#running) {
			return [
				{ keys: "Esc/Ctrl+C", label: "cancel" },
				{ keys: "PageUp", label: "page" },
				help,
			];
		}
		return [
			{ keys: "Enter", label: "send" },
			{ keys: "↑/↓", label: "history" },
			{ keys: "Ctrl+L", label: "redraw" },
			{ keys: "Ctrl+D", label: "quit" },
			help,
		];
	}
}
