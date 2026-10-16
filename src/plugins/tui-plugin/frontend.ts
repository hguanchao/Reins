import type { AgentEvent } from "../../agent/events.ts";
import type { NotifyMode } from "../../config/config-file.ts";
import {
	concat,
	colorSupport,
	KeyDecoder,
	LineEditor,
	LiveRegion,
	plain,
	spinnerLine,
	styled,
	truncateLine,
	type KeyEvent,
	type Line,
	type Span,
	type Terminal,
} from "../../tui/index.ts";
import type { InteractiveFrontend, InteractiveRuntime } from "../../tui/frontend.ts";
import { isBuiltinCommand, runBuiltin } from "./commands.ts";
import { dialogDecision, dialogLines, type ConfirmDialog } from "./dialog.ts";
import { decideNotify, desktopNotificationsSupported, notificationSequence } from "./notify.ts";
import { Transcript } from "./transcript.ts";

/**
 * 交互式界面。
 *
 * 屏幕上只有两块：已经提交的历史留在终端的滚动区里，活动区放还没定型的内容——正在写的回答、
 * 正在跑的工具、输入框与状态行。提交过的内容不再重画，所以历史长了也不会变慢，使用者还能用
 * 终端自带的回滚、复制与搜索。
 *
 * 界面接管终端期间，按键全部由这里解释，因此 Ctrl+C 不再产生信号，而是「中止当前这一轮」；
 * 空闲时它才用来清空输入或退出。退出前必须把终端恢复原状——留在原始模式里，使用者的
 * shell 会连回显都没有。
 */

/** 状态行与输入框之间不留空行，活动区与它们之间留一行的呼吸空间。 */
const RESERVED_LINES = 1;

const PROMPT: Line = styled("› ", { color: "cyan" });
const PLACEHOLDER = "说点什么；/help 看命令";

export interface FrontendOptions {
	readonly terminal: Terminal;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export class TerminalFrontend implements InteractiveFrontend {
	readonly #terminal: Terminal;
	readonly #region: LiveRegion;
	readonly #desktopNotify: boolean;
	readonly #editor = new LineEditor();
	readonly #keys = new KeyDecoder();
	readonly #transcript: Transcript;

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
		this.#region = new LiveRegion(options.terminal, { colors: colorSupport(options.env) });
		this.#desktopNotify = desktopNotificationsSupported(options.env);
		this.#transcript = new Transcript(this.#width());
	}

	async run(runtime: InteractiveRuntime): Promise<void> {
		this.#runtime = runtime;
		this.#notifyMode = runtime.notify;
		this.#stopped = false;
		this.#startTerminal();

		try {
			this.#region.commit(this.#welcomeLines(runtime));
			runtime.setConfirmer((question, detail) => this.#ask(question, detail));
			this.#refresh();

			await new Promise<void>((resolve) => {
				this.#done = resolve;
			});
		} finally {
			this.#restoreTerminal();
			runtime.setConfirmer(undefined);
			if (runtime.session.path !== null) {
				this.#terminal.write(`会话已保存：${runtime.session.path}\n`);
			}
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
		this.#terminal.setBracketedPaste(false);
		this.#terminal.setFocusReporting(false);
		this.#terminal.setCursorVisible(true);
		this.#terminal.setRawMode(false);
		process.off("exit", this.#restoreOnExit);
	}

	/** 进程退出时的兜底还原。这里不能做异步的事，只能把控制序列写出去。 */
	readonly #restoreOnExit = (): void => {
		try {
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
			default:
				break;
		}

		const lines = this.#transcript.handle(event, now);
		if (lines.length > 0) this.#region.commit(lines);
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
		this.#region.commit(lines);
		this.#refresh();
	}

	/** 组装一帧：活动块、对话框、输入区、状态行。 */
	#refresh(): void {
		if (this.#stopped || this.#runtime === undefined) return;

		const size = this.#terminal.size();
		const width = Math.max(1, size.cols);
		const editor = this.#editor.render({ width, prompt: PROMPT, placeholder: PLACEHOLDER });
		const dialog = this.#dialog === undefined ? [] : dialogLines(this.#dialog, width);
		const reserved = editor.lines.length + RESERVED_LINES + dialog.length;
		const capacity = Math.max(1, size.rows - reserved);

		const stable = this.#transcript.takeStable(capacity);
		if (stable.length > 0) this.#region.commit(stable);

		const live = this.#transcript.live({ maxLines: capacity, now: Date.now() });
		const lines = [...live, ...dialog, ...editor.lines, this.#statusLine(width)];
		this.#region.draw({
			lines,
			cursor: { row: live.length + dialog.length + editor.cursor.row, col: editor.cursor.col },
		});
	}

	#statusLine(width: number): Line {
		const runtime = this.#runtime;
		if (runtime === undefined) return [];

		const parts: Span[] = [styled(`${runtime.provider}/${runtime.model}`, { dim: true })[0]];
		if (this.#dialog !== undefined) {
			parts.push(...styled("　等待你的选择", { color: "yellow" }));
		} else if (this.#running) {
			parts.push(...spinnerLine(this.#activity, Date.now() - this.#turnStartedAt));
			parts.push(...styled("　Ctrl+C 中止", { dim: true }));
		} else {
			parts.push(...styled(`　approval=${runtime.approval}　sandbox=${runtime.sandbox}`, { dim: true }));
			parts.push(...styled("　/help 看命令", { dim: true }));
		}
		return truncateLine(parts, width);
	}
}
