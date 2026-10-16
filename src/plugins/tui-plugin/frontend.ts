import type { AgentEvent } from "../../agent/events.ts";
import type { NotifyMode } from "../../config/config-file.ts";
import {
	concat,
	colorSupport,
	KeyDecoder,
	LineEditor,
	lineWidth,
	plain,
	ScreenRegion,
	spinnerLine,
	styled,
	truncateLine,
	type KeyEvent,
	type Line,
	type Span,
	type Terminal,
} from "../../tui/index.ts";
import type { InteractiveFrontend, InteractiveRuntime } from "../../tui/frontend.ts";
import { describeUsage } from "../../session/usage.ts";
import { isBuiltinCommand, runBuiltin } from "./commands.ts";
import { dialogDecision, dialogLines, type ConfirmDialog } from "./dialog.ts";
import { decideNotify, desktopNotificationsSupported, notificationSequence } from "./notify.ts";
import { Transcript } from "./transcript.ts";

/**
 * 交互式界面。
 *
 * 界面运行在终端的备用屏里，整块屏幕都归它：外框、会话区、底部六行（状态行、输入框、信息行）
 * 每一帧从头画到尾。因为整屏都是自己的，回看历史不能再靠终端的滚动区，得自己翻——PageUp
 * 与 PageUp 翻页，End 回到底部恢复跟尾。
 *
 * 界面接管终端期间，按键全部由这里解释，因此 Ctrl+C 不再产生信号，而是「中止当前这一轮」；
 * 空闲时它才用来清空输入或退出。退出前必须把备用屏交还、终端恢复原状——留在原始模式里，
 * 使用者的 shell 会连回显都没有。
 */

/** Footer 固定六行，确认框与常态输入区等高，所以两者切换时 Main 一行都不跳。 */
const FOOTER_ROWS = 6;

/** 使用者的消息顶格在两列；模型的产出（工具调用与回答）整体再缩进两列。 */
const USER_INDENT = "  ";

const PROMPT: Line = [...plain(USER_INDENT), ...styled("› ", { color: "cyan" })];
const PLACEHOLDER = "说点什么；/help 看命令";

/** 输入区的上下实线。两端接进外框，因此铺满整屏宽。 */
const inputRule = (width: number): Line => plain(`├${"─".repeat(Math.max(1, width - 2))}┤`);

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
	/** 会话的全部行。备用屏没有终端滚动区，回看历史靠这里。 */
	readonly #history: Line[] = [];
	/** 视口底边离内容末尾多少行；undefined 表示跟尾——新内容到达时画面跟着往下走。 */
	#scrollFromEnd: number | undefined;

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
		this.#transcript = new Transcript(this.#width());
	}

	async run(runtime: InteractiveRuntime): Promise<void> {
		this.#runtime = runtime;
		this.#notifyMode = runtime.notify;
		this.#stopped = false;
		this.#startTerminal();

		try {
			this.#commit(this.#welcomeLines(runtime));
			runtime.setConfirmer((question, detail) => this.#ask(question, detail));
			this.#refresh();

			await new Promise<void>((resolve) => {
				this.#done = resolve;
			});
		} finally {
			this.#restoreTerminal();
			runtime.setConfirmer(undefined);
			// 备用屏一交还，整个对话就从屏幕上消失了。主屏上必须留下三条信息：
			// 存在哪儿、怎么接着聊、花了多少——最后一条复用会话统计的那份输出
			const usage = runtime.sessionUsage();
			const where = runtime.session.path ?? "（只留在内存里）";
			this.#terminal.write(
				`会话已保存：${where}\n` +
					`接续这次对话：reins --resume ${runtime.session.id}\n` +
					(usage.requests === 0
						? ""
						: `用量：${describeUsage(usage)}\n`),
			);
			this.#runtime = undefined;
		}
	}

	#width(): number {
		return Math.max(1, this.#terminal.size().cols);
	}

	#startTerminal(): void {
		this.#terminal.setRawMode(true);
		this.#terminal.setBracketedPaste(true);
		this.#terminal.setFocusReporting(true);
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
			this.#terminal.setBracketedPaste(false);
			this.#terminal.setFocusReporting(false);
			this.#terminal.setCursorVisible(true);
			this.#terminal.setRawMode(false);
		} catch {
			// 退出路径上再抛错没有任何意义
		}
	};

	#welcomeLines(runtime: InteractiveRuntime): readonly Line[] {
		const lines: Line[] = [
			concat(
				styled("Reins", { bold: true, color: "cyan" }),
				plain(`  ${runtime.provider}/${runtime.model}`),
			),
			styled(
				`approval=${runtime.approval} · sandbox=${runtime.sandbox} · 输入一句话开始；/help 看命令`,
				{ dim: true },
			),
		];

		// 接续旧会话时屏幕上没有历史：至少要说清还有多少条在前面，以及去哪儿看
		if (runtime.session.entries > 0) {
			lines.push(
				styled(
					`接续会话 ${runtime.session.id}：已有 ${runtime.session.entries} 条条目，` +
						`用 reins sessions show ${runtime.session.id} 看完整记录`,
					{ color: "cyan" },
				),
			);
		}

		if (!runtime.trust.trusted && runtime.trust.files.length > 0) {
			lines.push(
				styled(
					`工作区自带的配置没有读取：${runtime.trust.files.join("、")}（用 /trust yes 打开）`,
					{ color: "yellow" },
				),
			);
		}
		return lines;
	}

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
			if (this.#dialog !== undefined) {
				if (event.type === "key" && event.name === "ctrl-c") {
					// 询问期间按 Ctrl+C：既拒绝，也把这一轮停掉
					this.#interrupt();
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

	#handleKey(event: Extract<KeyEvent, { type: "key" }>): void {
		if (event.name === "pageup" || event.name === "pagedown") {
			const page = Math.max(1, Math.floor(this.#mainRows() / 2));
			this.#scrollBy(event.name === "pageup" ? page : -page);
			return;
		}
		// 其余按键都意味着回到正在进行的对话：视口恢复跟尾
		this.#scrollFromEnd = undefined;
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
				this.#interrupt();
				break;
			case "ctrl-d":
				if (this.#editor.isEmpty && !this.#running) this.#exit();
				return;
			default:
				// tab、escape 等目前没有绑定，按了就当没按
				return;
		}
		this.#refresh();
	}

	async #submit(): Promise<void> {
		const runtime = this.#runtime;
		if (runtime === undefined) return;

		if (this.#running) {
			this.#commit([styled("正在执行上一轮，等它结束再发送；Ctrl+C 可以中止。", { color: "yellow" })]);
			return;
		}

		const text = this.#editor.submit();
		if (text.trim().length === 0) {
			this.#refresh();
			return;
		}

		this.#commit(this.#transcript.userTurn(text));

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
			this.#commit([styled(error instanceof Error ? error.message : String(error), { color: "red" })]);
		}
	}

	async #runTurn(runtime: InteractiveRuntime, prompt: string): Promise<void> {
		this.#running = true;
		this.#activity = "正在思考";
		this.#turnStartedAt = Date.now();
		const controller = new AbortController();
		this.#abort = controller;
		this.#startTicker();
		this.#refresh();

		try {
			await runtime.createDriver((event) => this.#onAgentEvent(event)).run(prompt, controller.signal);
		} catch (error) {
			// 驱动把可预期的失败都编码进了事件，走到这里说明出了意料之外的事
			this.#commit([styled(`出错：${error instanceof Error ? error.message : String(error)}`, { color: "red" })]);
		} finally {
			this.#running = false;
			this.#abort = undefined;
			this.#activity = "";
			this.#stopTicker();
			this.#transcript.clearRunning();
			this.#refresh();
			this.#notify("已完成");
		}
	}

	#onAgentEvent(event: AgentEvent): void {
		const now = Date.now();
		switch (event.type) {
			case "turn_start":
				this.#activity = "正在思考";
				break;
			case "tool_start":
				this.#activity = `正在执行 ${event.name}`;
				break;
			case "tool_end":
				this.#activity = "正在思考";
				break;
			case "compaction_start":
				this.#activity = "正在压缩上下文";
				break;
			case "compaction_end":
			case "compaction_failed":
				this.#activity = "正在思考";
				break;
			default:
				break;
		}

		const lines = this.#transcript.handle(event, now);
		this.#commit(lines);
		this.#refresh();
	}

	#interrupt(): void {
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
		this.#exit();
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
		this.#transcript.resize(this.#width());
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
		this.#history.push(...lines);
		// 往上翻过就把画面钉在原地：新到的内容不把视口拉走
		if (this.#scrollFromEnd !== undefined) this.#scrollFromEnd += lines.length;
		this.#refresh();
	}

	/** Main 区当前有几行可用，翻页的步长按它算。 */
	#mainRows(): number {
		return Math.max(1, this.#terminal.size().rows - FOOTER_ROWS - 2);
	}

	/** 翻页。翻到底部时自动恢复跟尾。 */
	#scrollBy(delta: number): void {
		const next = (this.#scrollFromEnd ?? 0) + delta;
		this.#scrollFromEnd = next <= 0 ? undefined : next;
		this.#refresh();
	}

	/** 组装一帧：外框、会话区的可见窗口、Footer。 */
	#refresh(): void {
		if (this.#stopped || this.#runtime === undefined) return;

		const size = this.#terminal.size();
		const width = Math.max(8, size.cols);
		const height = Math.max(FOOTER_ROWS + 3, size.rows);

		const editor = this.#editor.render({ width: width - 4, prompt: PROMPT, placeholder: PLACEHOLDER });
		// 确认框顶掉整个 Footer；两种形态等高，所以 Main 的高度不随它变
		const dialog = this.#dialog === undefined ? undefined : dialogLines(this.#dialog, width - 4);
		const footer =
			dialog === undefined ? this.#footerRows(editor, width) : this.#confirmFooterRows(dialog, width);
		const mainRows = Math.max(1, height - footer.rows.length - 2);

		const transcript = [...this.#history, ...this.#transcript.live({ maxLines: mainRows, now: Date.now() })];
		const maxStart = Math.max(0, transcript.length - mainRows);
		let start = maxStart;
		if (this.#scrollFromEnd !== undefined) {
			start = Math.max(0, Math.min(maxStart, maxStart - this.#scrollFromEnd));
			// 已经翻到底了就恢复跟尾，别让「正在翻阅」的提示一直挂着
			if (start === maxStart) this.#scrollFromEnd = undefined;
		}
		const visible = transcript.slice(start, start + mainRows);
		while (visible.length < mainRows) visible.push(plain(""));

		const rows: Line[] = [plain(`┌${"─".repeat(width - 2)}┐`)];
		for (const line of visible) rows.push(frameRow(line, width));
		rows.push(...footer.rows);
		rows.push(plain(`└${"─".repeat(width - 2)}┘`));

		// 光标在输入那一行：上面隔着顶框与整块 Main
		this.#region.draw({
			lines: rows,
			cursor: { row: 1 + mainRows + footer.editorAt + editor.cursor.row, col: 2 + editor.cursor.col },
		});
	}

	/** 常态 Footer：空行 / 状态行 / 实线 / 输入 / 实线 / 信息行。 */
	#footerRows(editor: { readonly lines: readonly Line[] }, width: number): {
		readonly rows: readonly Line[];
		readonly editorAt: number;
	} {
		return {
			rows: [
				frameRow(plain(""), width),
				frameRow(this.#statusLine(width - 4), width),
				inputRule(width),
				...editor.lines.map((line) => frameRow(line, width)),
				inputRule(width),
				frameRow(this.#infoLine(width - 4), width),
			],
			editorAt: 3,
		};
	}

	/** 确认框顶掉整个 Footer：实线 / 空 / 问题 / 空 / 选项 / 实线。 */
	#confirmFooterRows(
		dialog: readonly Line[],
		width: number,
	): { readonly rows: readonly Line[]; readonly editorAt: number } {
		return {
			rows: [
				inputRule(width),
				frameRow(plain(""), width),
				...dialog.map((line) => frameRow(line, width)),
				frameRow(plain(""), width),
				frameRow(plain("  y 允许　n 拒绝　a 本次全部允许"), width),
				inputRule(width),
			],
			editorAt: 0,
		};
	}

	/** 底部信息行。放不下时只留模型名。 */
	#infoLine(width: number): Line {
		const runtime = this.#runtime;
		if (runtime === undefined) return plain("");

		const full = `${runtime.provider}/${runtime.model}　approval=${runtime.approval}　sandbox=${runtime.sandbox}　/help 看命令`;
		return truncateLine(styled(full, { dim: true }), width);
	}

	#statusLine(width: number): Line {
		const runtime = this.#runtime;
		if (runtime === undefined) return plain("");

		const parts: Span[] = [];
		if (this.#running) {
			parts.push(...spinnerLine(this.#activity, Date.now() - this.#turnStartedAt));
			parts.push(...styled("　Ctrl+C 中止", { dim: true }));
		} else if (this.#dialog !== undefined) {
			parts.push(...styled("等待你的选择", { color: "yellow" }));
		} else {
			const usage = runtime.sessionUsage();
			parts.push(
				...styled(
					usage.requests === 0
						? "就绪"
						: `就绪　本轮 ${usage.total} token${usage.cost === undefined ? "" : `　$${usage.cost.toFixed(4)}`}`,
					{ dim: true },
				),
			);
		}
		if (this.#scrollFromEnd !== undefined) {
			parts.push(...styled("　↑ 正在翻阅历史　PageDown 回到底部", { color: "yellow" }));
		}
		return truncateLine(parts, width);
	}
}

/** 给一行补上左右外框：内容居左，右侧补空格到边。 */
function frameRow(line: Line, width: number): Line {
	const inner = Math.max(1, width - 2);
	const fitted = lineWidth(line) > inner ? truncateLine(line, inner) : line;
	const gap = Math.max(0, inner - lineWidth(fitted));
	return [...plain("│"), ...fitted, ...plain(`${" ".repeat(gap)}│`)];
}
