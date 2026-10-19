import { eastAsianWidth } from "get-east-asian-width";
import { StringDecoder } from "node:string_decoder";

import type { AgentEvent, AgentEventListener } from "../agent/events.ts";
import { COMPACT_FOOTER_HEIGHT, FOOTER_HEIGHT, inputView, renderFooter, type FooterInfo } from "./footer.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../config/config-file.ts";
import type { ApprovalBroker, ApprovalPrompt } from "../permission/approval.ts";
import { renderMain } from "./main.ts";
import { APPROVAL_PANEL_HEIGHT, renderApprovalPanel } from "./approval-panel.ts";
import {
	modelMenuHeight,
	renderModelMenu,
	type ModelMenuItem,
	type ModelMenuState,
} from "./model-menu.ts";
import {
	effortMenuHeight,
	renderEffortMenu,
	type EffortMenuState,
} from "./effort-menu.ts";
import {
	commandMenuHeight,
	renderCommandMenu,
	type CommandMenuItem,
	type CommandMenuState,
} from "./command-menu.ts";
import { keepVisible } from "./menu-panel.ts";
import { helpPageLines, renderHelpPage } from "./help-page.ts";
import { renderTranscript, scrollbarColumn, transcriptMetrics, type TranscriptTurn } from "./transcript.ts";

/**
 * 全屏启动。
 *
 * 进入终端的备用屏，按当前尺寸铺满整个窗口；尺寸变化时重画。页脚是带运行时状态、输入框与
 * 常驻信息行的区域。回车把输入交给 TurnDriver，模型文本、工具调用与压缩进度作为事件实时
 * 进入对话流。输入 / 时展开命令补全面板，/model 与 /effort 再展开选择面板，/help 把主区域
 * 换成整屏帮助页。工具需要确认时在输入框上方弹出审批面板。一轮进行中 Ctrl+C 只中止当前轮，
 * 空闲时连按两次才退出。
 */

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** 终端光标形状：5 是闪烁竖线，0 是恢复终端默认。 */
const CURSOR_BLINKING_BAR = "\x1b[5 q";
const CURSOR_DEFAULT = "\x1b[0 q";
/** 打开/关闭终端的焦点上报；关闭后终端不会再往输入里塞焦点事件。 */
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
/** 按钮事件上报加 SGR 坐标；按住拖动时也会收到移动事件。 */
const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/** Ctrl+C 在原始模式下以控制字符到达，不会触发 SIGINT，必须自己识别。 */
const CTRL_C = "\x03";
/** 第一次 Ctrl+C 之后等待第二次的时间；超过就回到未确认状态。 */
const EXIT_CONFIRM_WINDOW_MS = 2000;
/** 运行时状态前的加载动画。 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 100;
/** 每帧把扫光往前推多少；整个状态行约 1.25 秒扫一遍。 */
const SWEEP_STEP = 0.08;
/** 滚轮每格滚动固定行数，保持手感稳定。 */
const WHEEL_STEP = 3;

const WAITING_FOR_RESPONSE = "Waiting for response...";
const THINKING = "Thinking...";
const WRITING_RESPONSE = "Writing response...";
const DONE = "Done";
/** 配置不可用时按下回车给出的提示；不启动对话，避免看起来已经正常工作。 */
const CONFIGURATION_REQUIRED = "Configuration required";
const AGENT_UNAVAILABLE = "Agent unavailable";
const ABORTING = "Aborting...";
const ABORTED = "Aborted";
const ERROR_STATUS = "Error";
/** 一轮结束后状态行停留的时间。 */
const STATUS_CLEAR_MS = 1500;

/** 对话流里的一条真实回合；response 可变，流式文本和工具行持续追加。 */
interface LiveTurn extends TranscriptTurn {
	response: string[];
}

/** 一轮正在进行的对话。 */
interface ActiveTurn {
	readonly turn: LiveTurn;
	readonly controller: AbortController;
	readonly startedAt: number;
	/** 已经完成的文本与工具行 */
	readonly lines: string[];
	/** 当前还没等到换行的文本 */
	partial: string;
	outcome: "done" | "error" | "aborted";
}

/** 界面只依赖终端的这几个能力，测试因此可以交进假终端。 */
export interface TuiInput {
	readonly isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
	resume(): unknown;
	pause(): unknown;
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

export interface TuiOutput {
	readonly isTTY?: boolean;
	columns?: number;
	rows?: number;
	write(chunk: string): unknown;
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
}

export interface ModelSwitchResult {
	/** 需要显示在对话流里的说明 */
	readonly warnings: readonly string[];
	/** 选择并写回配置后，界面是否可以正常提交 */
	readonly ready: boolean;
	/** 新的启动警告；undefined 表示清除 */
	readonly warning: string | undefined;
}

export interface ModelMenuSource {
	/** 当前可选的模型；每次打开菜单时重新取，current 标记才会跟着切换更新 */
	readonly list: () => readonly ModelMenuItem[];
	/** 确认选择；返回需要显示在对话流里的说明与新的受限状态 */
	readonly select: (item: ModelMenuItem) => ModelSwitchResult;
}

export interface EffortMenuSource {
	/** 当前配置里的思考等级；切换后重新读取 */
	readonly current: () => ThinkingLevel;
	/** 确认选择；失败时抛错，由界面显示原因 */
	readonly select: (level: ThinkingLevel) => void;
}

/** 真实对话入口；由启动装配提供。 */
export interface AgentRuntime {
	/** 跑一轮对话，事件驱动界面；signal 用于 Ctrl+C 中止。 */
	readonly runTurn: (
		prompt: string,
		onEvent: AgentEventListener,
		signal: AbortSignal,
	) => Promise<void>;
	/** 会话记下新的用量或压缩后刷新页脚统计。 */
	readonly refreshInfo: () => void;
}

export interface TuiOptions {
	readonly version: string;
	/** 输入框下方常驻信息：项目、分支、模型、思考强度、上下文与缓存命中率 */
	readonly info: FooterInfo | (() => FooterInfo);
	/** 配置有问题时在主区域显示的一行警告；配置正常时不传 */
	readonly warning?: string;
	/** 配置不可用时为 false：界面照常显示，但不接受提交 */
	readonly ready?: boolean;
	/** 真实对话入口；不提供时无法提交普通提示 */
	readonly agent?: AgentRuntime;
	/** 工具审批桥接；不提供时不会弹出审批面板 */
	readonly approval?: ApprovalBroker;
	/** /model 菜单的数据来源；不提供时 /model 按普通输入处理 */
	readonly modelMenu?: ModelMenuSource;
	/** /effort 菜单的数据来源；不提供时 /effort 不可用 */
	readonly effortMenu?: EffortMenuSource;
	/** 启动时回填的历史对话；续聊时使用 */
	readonly history?: readonly TranscriptTurn[];
	readonly stdin?: TuiInput;
	readonly stdout?: TuiOutput;
}

/**
 * 在备用屏里显示界面，直到使用者连按两次 Ctrl+C。
 *
 * 返回值就是进程退出码：正常退出为 0。终端不是 TTY 时由调用方先拦下，这里不重复判断——
 * 原始模式只在真实终端上存在。
 */
export async function runTui(options: TuiOptions): Promise<number> {
	const stdin: TuiInput = options.stdin ?? process.stdin;
	const stdout: TuiOutput = options.stdout ?? process.stdout;
	let ready = options.ready ?? true;
	let activeWarning = options.warning;
	// 命令补全列表：配置不可用时仍然显示，但标成不可执行
	const commands: readonly CommandMenuItem[] = [
		{
			name: "model",
			description:
				options.modelMenu === undefined
					? "Requires a valid configuration"
					: "Choose the model for this session",
			enabled: options.modelMenu !== undefined,
		},
		{
			name: "effort",
			description:
				options.effortMenu === undefined
					? "Requires a valid configuration"
					: "Choose the reasoning effort for this session",
			enabled: options.effortMenu !== undefined,
		},
		{
			name: "help",
			description: "Show the commands and keys",
			enabled: true,
		},
	];

	let input = "";
	const turns: LiveTurn[] = (options.history ?? []).map((turn) => ({
		prompt: turn.prompt,
		response: [...turn.response],
	}));
	/** 有历史或输入过内容就显示对话流。 */
	let hasInput = turns.length > 0;
	/** 首次绘制时把已有历史滚到底部。 */
	let initialScroll = turns.length > 0;
	/** 终端窗口是否有焦点；界面启动时默认有焦点。 */
	let focused = true;
	/** 对话流从顶部滚过的行数。 */
	let scrollTop = 0;
	/** 是否跟随新内容滚到底部。 */
	let follow = true;
	/** 是否正按住滚动条拖动。 */
	let draggingScrollbar = false;
	/** 当前运行时状态；为空表示空闲。 */
	let statusText: string | undefined;
	let statusPhaseMs = 0;
	let statusElapsedMs = 0;
	let statusTokens = 0;
	let statusPhaseStartedAt = 0;
	let spinnerFrame = 0;
	let sweepPhase = 0;
	let activeTurn: ActiveTurn | undefined;
	let approvalPrompt: ApprovalPrompt | undefined;
	let modelMenu: ModelMenuState | undefined;
	let effortMenu: EffortMenuState | undefined;
	let commandMenu: CommandMenuState | undefined;
	/** 帮助页是否占据主区域；打开期间视口只跟着它自己的滚动。 */
	let helpOpen = false;
	/** 帮助页从顶部滚过的行数。 */
	let helpScrollTop = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
	let exitArmed = false;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let finish = (): void => {};
	const decoder = new StringDecoder("utf8");

	const currentInfo = (): FooterInfo =>
		typeof options.info === "function" ? options.info() : options.info;
	const menuHeight = (): number =>
		approvalPrompt !== undefined
			? APPROVAL_PANEL_HEIGHT
			: modelMenu !== undefined
				? modelMenuHeight(modelMenu.items.length)
				: effortMenu !== undefined
					? effortMenuHeight()
					: commandMenu !== undefined
						? commandMenuHeight(commandMenu.items.length)
						: 0;
	const menuOpen = (): boolean =>
		approvalPrompt !== undefined ||
		modelMenu !== undefined ||
		effortMenu !== undefined ||
		commandMenu !== undefined;
	/** 帮助页与菜单一样把输入框让给内容：紧凑页脚、不画光标。 */
	const compactFooter = (): boolean => menuOpen() || helpOpen;
	const footerHeight = (): number =>
		compactFooter() ? COMPACT_FOOTER_HEIGHT + menuHeight() : FOOTER_HEIGHT;

	const render = (): void => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = terminalHeight(stdout);
		const mainHeight = Math.max(0, height - footerHeight());
		const metrics = transcriptMetrics(width, mainHeight, turns, activeWarning);
		const maxScroll = Math.max(0, metrics.scrollLines - mainHeight);
		if (initialScroll) {
			scrollTop = maxScroll;
			initialScroll = false;
		} else {
			scrollTop = Math.min(scrollTop, maxScroll);
		}

		const status =
			statusText === undefined
				? undefined
				: {
						symbol: SPINNER_FRAMES[spinnerFrame] ?? "",
						text: statusText,
						sweep: sweepPhase,
						phaseMs: statusPhaseMs,
						elapsedMs: statusElapsedMs,
						tokens: statusTokens,
					};
		const menuLines =
			approvalPrompt !== undefined
				? renderApprovalPanel(width, approvalPrompt)
				: modelMenu !== undefined
					? renderModelMenu(width, modelMenu)
					: effortMenu !== undefined
						? renderEffortMenu(width, effortMenu)
						: commandMenu !== undefined
							? renderCommandMenu(width, commandMenu)
							: [];
		const footer = compactFooter()
			? renderFooter(
					width,
					input,
					focused &&
						modelMenu === undefined &&
						effortMenu === undefined &&
						approvalPrompt === undefined &&
						!helpOpen,
					undefined,
					currentInfo(),
					{ leadingGap: false, showStatus: false },
				)
			: renderFooter(width, input, focused, status, currentInfo());
		const transcriptShown = !helpOpen && (hasInput || activeWarning !== undefined);
		const main = helpOpen
			? renderHelpPage(helpPageLines(width, commands), mainHeight, helpScrollTop)
			: transcriptShown
				? renderTranscript(width, mainHeight, turns, scrollTop, activeWarning)
				: renderMain(width, mainHeight, options.version);
		// 整屏自上而下：主区域、面板、页脚；终端比内容矮时只保留前几行
		const lines = [...main, ...menuLines, ...footer].slice(0, height);
		const inputRow = compactFooter()
			? mainHeight + menuHeight() + (COMPACT_FOOTER_HEIGHT - 2)
			: mainHeight + (FOOTER_HEIGHT - 2);
		const cursor =
			focused &&
			!helpOpen &&
			modelMenu === undefined &&
			effortMenu === undefined &&
			approvalPrompt === undefined &&
			inputRow <= height
				? moveCursor(inputRow, inputView(input, width).column) + SHOW_CURSOR
				: "";

		// 每一行按自己的坐标写，而不是靠换行符顺推。一行的实际列宽取决于终端怎么算其中的字符
		// （歧义宽度字符各终端算 1 列或 2 列），算得比我们宽时终端会替它换行，顺推下去后面的
		// 行就整体错位。按坐标写时溢出的尾巴会被下一行覆盖，只损失这一行末尾一两个字符。
		let frame = HIDE_CURSOR + CURSOR_HOME + CLEAR_SCREEN;
		for (let row = 0; row < lines.length; row += 1) {
			frame += `${moveCursor(row + 1, 1)}${lines[row]}`;
		}
		// 滚动条列最后单独画：它只依赖自己的行列位置，内容怎么换行都不会把它带断
		if (transcriptShown) {
			const gutter = scrollbarColumn(mainHeight, metrics.scrollLines, scrollTop);
			for (let row = 0; row < gutter.length; row += 1) {
				frame += `${moveCursor(row + 1, width)}${gutter[row]}`;
			}
		}
		stdout.write(frame + cursor);
	};

	const maxScroll = (): number => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const mainHeight = Math.max(0, terminalHeight(stdout) - footerHeight());
		return Math.max(0, transcriptMetrics(width, mainHeight, turns, activeWarning).scrollLines - mainHeight);
	};

	const disarm = (): void => {
		if (exitTimer !== undefined) {
			clearTimeout(exitTimer);
			exitTimer = undefined;
		}
		exitArmed = false;
	};

	const cleanup = (): void => {
		if (finished) return;
		finished = true;

		if (activeTurn !== undefined) {
			options.approval?.denyAll();
			activeTurn.controller.abort();
		}
		if (exitTimer !== undefined) {
			clearTimeout(exitTimer);
			exitTimer = undefined;
		}
		if (spinnerTimer !== undefined) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		if (statusClearTimer !== undefined) {
			clearTimeout(statusClearTimer);
			statusClearTimer = undefined;
		}
		stdout.off("resize", render);
		stdin.off("data", onData);
		process.off("SIGINT", onInterrupt);
		stdin.setRawMode?.(false);
		stdin.pause();
		stdout.write(DISABLE_MOUSE + DISABLE_FOCUS_REPORTING + CURSOR_DEFAULT + SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN);
		finish();
	};

	const onCtrlC = (): void => {
		if (activeTurn !== undefined) {
			// 第一次只中止当前轮；2 秒内再按一次强制退出
			if (exitArmed) {
				cleanup();
				return;
			}
			exitArmed = true;
			exitTimer = setTimeout(disarm, EXIT_CONFIRM_WINDOW_MS);
			options.approval?.denyAll();
			activeTurn.controller.abort();
			setStatus(ABORTING);
			render();
			return;
		}
		if (exitArmed) {
			cleanup();
			return;
		}
		exitArmed = true;
		exitTimer = setTimeout(disarm, EXIT_CONFIRM_WINDOW_MS);
	};

	const setStatus = (text: string): void => {
		statusText = text;
		statusPhaseMs = 0;
		statusPhaseStartedAt = Date.now();
	};

	const scheduleStatusClear = (): void => {
		if (statusClearTimer !== undefined) clearTimeout(statusClearTimer);
		statusClearTimer = setTimeout(() => {
			statusClearTimer = undefined;
			statusText = undefined;
			statusPhaseMs = 0;
			statusElapsedMs = 0;
			statusTokens = 0;
			render();
		}, STATUS_CLEAR_MS);
	};

	const stopSpinner = (): void => {
		if (spinnerTimer === undefined) return;
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	/** 审批请求可能在工具线程里异步出现，刷新帧顺带把它同步到界面上。 */
	const syncApprovalPrompt = (): boolean => {
		const next = options.approval?.pending();
		const changed =
			next === undefined
				? approvalPrompt !== undefined
				: approvalPrompt === undefined ||
					approvalPrompt.question !== next.question ||
					approvalPrompt.detail !== next.detail;
		approvalPrompt = next;
		return changed;
	};

	const startSpinner = (): void => {
		if (spinnerTimer !== undefined) return;

		spinnerTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			sweepPhase = (sweepPhase + SWEEP_STEP) % 1;
			if (activeTurn !== undefined) {
				const now = Date.now();
				statusElapsedMs = now - activeTurn.startedAt;
				statusPhaseMs = Math.max(0, now - statusPhaseStartedAt);
				statusTokens = estimateTokens(
					[...activeTurn.lines, activeTurn.partial].join(" "),
				);
				syncApprovalPrompt();
			}
			render();
		}, SPINNER_INTERVAL_MS);
	};

	const syncTurn = (active: ActiveTurn): void => {
		const response =
			active.partial.length > 0 ? [...active.lines, active.partial] : active.lines;
		active.turn.response.splice(0, active.turn.response.length, ...response);
	};

	const syncScroll = (): void => {
		if (follow) scrollTop = maxScroll();
	};

	const flushPartial = (active: ActiveTurn): void => {
		if (active.partial.length === 0) return;
		active.lines.push(active.partial);
		active.partial = "";
	};

	const appendAssistantText = (active: ActiveTurn, delta: string): void => {
		active.partial += delta;
		const parts = active.partial.split("\n");
		active.partial = parts.pop() ?? "";
		active.lines.push(...parts);
		syncTurn(active);
		syncScroll();
	};

	const appendLine = (active: ActiveTurn, line: string): void => {
		flushPartial(active);
		active.lines.push(line);
		syncTurn(active);
		syncScroll();
	};

	const onEvent: AgentEventListener = (event: AgentEvent): void => {
		const active = activeTurn;
		if (active === undefined) return;

		switch (event.type) {
			case "turn_start":
				setStatus(WAITING_FOR_RESPONSE);
				break;
			case "text_delta":
				appendAssistantText(active, event.text);
				setStatus(WRITING_RESPONSE);
				break;
			case "reasoning_delta":
				setStatus(THINKING);
				break;
			case "tool_start":
				appendLine(active, `· ${event.name} ${summarizeArgs(event.args)}`);
				setStatus(`Running ${event.name}...`);
				break;
			case "tool_update":
				setStatus("Running tool...");
				break;
			case "tool_end":
				appendLine(
					active,
					event.isError
						? `  failed ${event.durationMs}ms: ${event.summary}`
						: `  done ${event.durationMs}ms`,
				);
				setStatus(THINKING);
				break;
			case "compaction_start":
				appendLine(
					active,
					`· compacting context (${event.messages} messages, ~${event.tokensBefore} tokens)`,
				);
				setStatus("Compacting context...");
				break;
			case "compaction_end":
				appendLine(
					active,
					`  compacted: ~${event.tokensBefore} → ~${event.tokensAfter} tokens`,
				);
				options.agent?.refreshInfo();
				break;
			case "compaction_failed":
				appendLine(active, `  compaction failed: ${event.message}`);
				break;
			case "usage_recorded":
				// 每次请求的用量都反映到页脚上，不必等整轮跑完
				options.agent?.refreshInfo();
				break;
			case "error":
				appendLine(active, `error: ${event.message}`);
				active.outcome = "error";
				setStatus(ERROR_STATUS);
				break;
			case "aborted":
				appendLine(active, "aborted");
				active.outcome = "aborted";
				setStatus(ABORTED);
				break;
			case "turn_end":
			case "run_end":
				break;
		}

		// 文本增量由 100ms 刷新帧统一绘制；工具、错误等阶段变化立即重画
		if (
			event.type !== "text_delta" &&
			event.type !== "reasoning_delta" &&
			event.type !== "tool_update" &&
			event.type !== "turn_end" &&
			event.type !== "run_end"
		) {
			render();
		}
	};

	/** 让光标始终落在可见窗口内；窗口最多 8 行。 */
	const keepMenuCursor = (): void => {
		if (modelMenu === undefined) return;
		modelMenu.scrollTop = keepVisible(modelMenu.scrollTop, modelMenu.cursor, modelMenu.items.length);
	};

	const openModelMenu = (): void => {
		const source = options.modelMenu;
		if (source === undefined) return;

		commandMenu = undefined;
		effortMenu = undefined;
		const items = source.list();
		if (items.length === 0) {
			input = "";
			turns.push({ prompt: "/model", response: ["No models are available."] });
			hasInput = true;
			render();
			return;
		}

		const current = items.findIndex((item) => item.current);
		modelMenu = { items, cursor: current >= 0 ? current : 0, scrollTop: 0 };
		keepMenuCursor();
		render();
	};

	const moveMenu = (delta: number): void => {
		if (modelMenu === undefined) return;
		modelMenu.cursor = Math.min(
			modelMenu.items.length - 1,
			Math.max(0, modelMenu.cursor + delta),
		);
		keepMenuCursor();
		render();
	};

	const confirmMenu = (): void => {
		if (modelMenu === undefined) return;

		const item = modelMenu.items[modelMenu.cursor];
		const source = options.modelMenu;
		modelMenu = undefined;
		effortMenu = undefined;
		commandMenu = undefined;
		input = "";

		if (item !== undefined && source !== undefined) {
			let response: string[];
			try {
				const result = source.select(item);
				ready = result.ready;
				activeWarning = result.warning;
				response = [`Model switched to ${item.provider}/${item.model}.`, ...result.warnings];
			} catch (error) {
				response = [
					`Failed to switch model: ${error instanceof Error ? error.message : String(error)}`,
				];
			}
			turns.push({ prompt: "/model", response });
			hasInput = true;
		}
		render();
	};

	const cancelMenu = (): void => {
		modelMenu = undefined;
		effortMenu = undefined;
		commandMenu = undefined;
		input = "";
		render();
	};

	const openEffortMenu = (): void => {
		const source = options.effortMenu;
		if (source === undefined) return;

		const current = source.current();
		const cursor = Math.max(0, THINKING_LEVELS.indexOf(current));
		commandMenu = undefined;
		modelMenu = undefined;
		effortMenu = {
			current,
			cursor,
			scrollTop: keepVisible(0, cursor, THINKING_LEVELS.length),
		};
		render();
	};

	const moveEffortMenu = (delta: number): void => {
		if (effortMenu === undefined) return;
		effortMenu.cursor = Math.min(
			THINKING_LEVELS.length - 1,
			Math.max(0, effortMenu.cursor + delta),
		);
		effortMenu.scrollTop = keepVisible(
			effortMenu.scrollTop,
			effortMenu.cursor,
			THINKING_LEVELS.length,
		);
		render();
	};

	const confirmEffortMenu = (): void => {
		if (effortMenu === undefined) return;

		const level = THINKING_LEVELS[effortMenu.cursor];
		const source = options.effortMenu;
		effortMenu = undefined;
		input = "";

		if (level !== undefined && source !== undefined) {
			let response: string[];
			try {
				source.select(level);
				response = [`Effort set to ${level}.`];
			} catch (error) {
				response = [
					`Failed to set effort: ${error instanceof Error ? error.message : String(error)}`,
				];
			}
			turns.push({ prompt: "/effort", response });
			hasInput = true;
		}
		render();
	};

	const cancelEffortMenu = (): void => {
		effortMenu = undefined;
		modelMenu = undefined;
		input = "";
		render();
	};

	/** 输入变化后重算命令补全列表；只匹配斜杠后不含空格的命令名。 */
	const updateCommandMenu = (): void => {
		if (modelMenu !== undefined) return;

		if (input.startsWith("/") && !input.slice(1).includes(" ")) {
			const query = input.slice(1).toLowerCase();
			const items = commands.filter((command) => command.name.startsWith(query));
			if (items.length > 0) {
				const previous = commandMenu?.items[commandMenu.cursor]?.name;
				const cursor =
					previous === undefined
						? 0
						: Math.max(0, items.findIndex((item) => item.name === previous));
				commandMenu = {
					items,
					cursor,
					scrollTop: keepVisible(0, cursor, items.length),
				};
				return;
			}
		}

		commandMenu = undefined;
	};

	const moveCommandMenu = (delta: number): void => {
		if (commandMenu === undefined) return;
		commandMenu.cursor = Math.min(
			commandMenu.items.length - 1,
			Math.max(0, commandMenu.cursor + delta),
		);
		commandMenu.scrollTop = keepVisible(
			commandMenu.scrollTop,
			commandMenu.cursor,
			commandMenu.items.length,
		);
		render();
	};

	const executeCommand = (command: CommandMenuItem): void => {
		commandMenu = undefined;
		// 从补全面板执行时把输入补全成完整命令，面板打开期间看得清当前在做什么
		input = `/${command.name}`;

		if (command.name === "model") {
			if (options.modelMenu === undefined) {
				input = "";
				statusElapsedMs = 0;
				statusTokens = 0;
				setStatus(CONFIGURATION_REQUIRED);
				render();
				return;
			}
			openModelMenu();
			return;
		}

		if (command.name === "effort") {
			if (options.effortMenu === undefined) {
				input = "";
				statusElapsedMs = 0;
				statusTokens = 0;
				setStatus(CONFIGURATION_REQUIRED);
				render();
				return;
			}
			openEffortMenu();
			return;
		}

		if (command.name === "help") {
			// 命令名不留在输入框里：帮助页期间输入框不接受按键
			input = "";
			helpOpen = true;
			helpScrollTop = 0;
			render();
			return;
		}

		// 未覆盖的命令不留在输入框里，避免看起来执行过了
		input = "";
		render();
	};

	/** 回车发送：把输入交给真实 TurnDriver，事件驱动对话流与状态行。 */
	const submit = (): boolean => {
		if (input.length === 0) return false;
		// 一轮进行中不接受新提交；状态行继续显示当前进度
		if (activeTurn !== undefined) return false;

		const message = input.trim();
		const selected = commandMenu?.items[commandMenu.cursor];
		const command = selected ?? commands.find((item) => `/${item.name}` === message);
		if (message.startsWith("/") && command !== undefined) {
			// 命令先于受限检查执行：/model 正是用来修复配置对不上的入口
			executeCommand(command);
			return true;
		}

		if (!ready) {
			// 配置没读成功时不进入对话：保留输入内容，只把原因放到运行时状态行
			commandMenu = undefined;
			statusElapsedMs = 0;
			statusTokens = 0;
			setStatus(CONFIGURATION_REQUIRED);
			render();
			return false;
		}

		const agent = options.agent;
		if (agent === undefined) {
			commandMenu = undefined;
			statusElapsedMs = 0;
			statusTokens = 0;
			setStatus(AGENT_UNAVAILABLE);
			render();
			return false;
		}

		input = "";
		if (message.length === 0) return false;

		const turn: LiveTurn = { prompt: message, response: [] };
		turns.push(turn);
		const active: ActiveTurn = {
			turn,
			controller: new AbortController(),
			startedAt: Date.now(),
			lines: [],
			partial: "",
			outcome: "done",
		};
		activeTurn = active;
		hasInput = true;
		follow = true;
		disarm();
		statusElapsedMs = 0;
		statusTokens = 0;
		if (statusClearTimer !== undefined) {
			clearTimeout(statusClearTimer);
			statusClearTimer = undefined;
		}
		setStatus(WAITING_FOR_RESPONSE);

		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const mainHeight = Math.max(0, terminalHeight(stdout) - footerHeight());
		scrollTop = transcriptMetrics(width, mainHeight, turns, activeWarning).lastPromptStart;
		startSpinner();
		render();

		void agent
			.runTurn(message, onEvent, active.controller.signal)
			.catch((error) => {
				if (finished || activeTurn !== active) return;
				appendLine(active, `error: ${error instanceof Error ? error.message : String(error)}`);
				active.outcome = "error";
				setStatus(ERROR_STATUS);
			})
			.finally(() => {
				if (activeTurn !== active) return;
				flushPartial(active);
				syncTurn(active);
				activeTurn = undefined;
				stopSpinner();
				options.approval?.denyAll();
				syncApprovalPrompt();
				if (finished) return;
				disarm();
				agent.refreshInfo();
				statusElapsedMs = Date.now() - active.startedAt;
				statusTokens = estimateTokens(active.lines.join(" "));
				setStatus(
					active.outcome === "done"
						? DONE
						: active.outcome === "aborted"
							? ABORTED
							: ERROR_STATUS,
				);
				scheduleStatusClear();
				render();
			});
		return true;
	};

	const onData = (chunk: Buffer): void => {
		const text = decoder.write(chunk);
		if (text.includes(CTRL_C)) {
			onCtrlC();
			return;
		}

		if (approvalPrompt !== undefined) {
			// 审批是模态的：y 放行，n / Enter / Esc 拒绝，其它按键忽略
			const decision = approvalKey(text);
			if (decision !== undefined) {
				options.approval?.resolve(decision);
				approvalPrompt = undefined;
				syncApprovalPrompt();
				render();
			}
			return;
		}

		if (modelMenu !== undefined || effortMenu !== undefined) {
			// 选择面板是模态的：只处理上下键、回车与 Esc，普通字符和其它转义序列都忽略
			const key = menuKey(text);
			if (modelMenu !== undefined) {
				if (key === "up") moveMenu(-1);
				else if (key === "down") moveMenu(1);
				else if (key === "enter") confirmMenu();
				else if (key === "escape") cancelMenu();
			} else {
				if (key === "up") moveEffortMenu(-1);
				else if (key === "down") moveEffortMenu(1);
				else if (key === "enter") confirmEffortMenu();
				else if (key === "escape") cancelEffortMenu();
			}
			return;
		}

		if (helpOpen) {
			// 帮助页也是模态的：上下键与滚轮翻页，Esc 返回，其它按键忽略
			const rows = Math.max(0, terminalHeight(stdout) - footerHeight());
			const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
			const total = helpPageLines(width, commands).length;
			let steps = 0;
			for (const event of mouseEvents(text)) {
				if (event.press && event.button === 64) steps -= 1;
				else if (event.press && event.button === 65) steps += 1;
			}
			const key = menuKey(text);
			if (key === "up") steps -= 1;
			if (key === "down") steps += 1;

			if (key === "escape") {
				helpOpen = false;
				render();
				return;
			}
			if (steps !== 0) {
				helpScrollTop = Math.min(Math.max(0, helpScrollTop + steps), Math.max(0, total - rows));
				render();
			}
			return;
		}

		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = terminalHeight(stdout);
		const mainHeight = Math.max(0, height - footerHeight());
		const limit = maxScroll();
		const beforeScroll = scrollTop;
		const withoutMouse = stripMouseEvents(text);
		let focusChanged = false;
		let wheelSteps = 0;
		let dragRow: number | undefined;

		const lastIn = withoutMouse.lastIndexOf(FOCUS_IN);
		const lastOut = withoutMouse.lastIndexOf(FOCUS_OUT);
		if (lastIn >= 0 || lastOut >= 0) {
			const next = lastIn > lastOut;
			if (next !== focused) {
				focused = next;
				focusChanged = true;
			}
			if (!next) draggingScrollbar = false;
		}

		for (const event of mouseEvents(text)) {
			const left = (event.button & 3) === 0;
			const motion = event.button >= 32 && event.button < 64;

			if (event.press && event.button === 64) {
				wheelSteps -= 1;
			} else if (event.press && event.button === 65) {
				wheelSteps += 1;
			} else if (event.press && left && !motion) {
				const insideInput = event.row >= Math.max(1, height - 2);
				if (insideInput !== focused) {
					focused = insideInput;
					focusChanged = true;
				}
				if (!insideInput && event.column === width && event.row <= mainHeight && turns.length > 0) {
					draggingScrollbar = true;
					dragRow = event.row;
				} else {
					draggingScrollbar = false;
				}
			} else if (event.press && left && motion) {
				if (draggingScrollbar) dragRow = event.row;
			} else if (!event.press) {
				draggingScrollbar = false;
			}
		}

		if (wheelSteps !== 0) {
			scrollTop = Math.min(limit, Math.max(0, scrollTop + wheelSteps * WHEEL_STEP));
			follow = scrollTop >= limit;
		}
		if (dragRow !== undefined) {
			scrollTop = scrollTopFromRow(dragRow, mainHeight, limit);
			follow = scrollTop >= limit;
		}
		const scrollChanged = scrollTop !== beforeScroll;

		if (commandMenu !== undefined) {
			// 命令补全面板不拦截文字输入，只接管上下键与 Esc
			const key = menuKey(text);
			if (key === "up" || key === "down") {
				moveCommandMenu(key === "up" ? -1 : 1);
				return;
			}
			if (key === "escape") {
				commandMenu = undefined;
				render();
				return;
			}
		}

		const previous = input;
		const result = appendInput(input, withoutMouse);
		input = result.text;
		updateCommandMenu();
		// 配置不可用时主区域要一直保留警告，不能因为敲了字就切到对话流；
		// 斜杠命令同样不是对话内容，补全面板与帮助页都盖在启动画面上
		if (input.length > 0 && !input.startsWith("/") && ready) hasInput = true;

		if (result.submit) {
			const submitted = submit();
			if (!submitted && (focusChanged || scrollChanged)) render();
			return;
		}
		if (input !== previous || focusChanged || scrollChanged) render();
	};

	const onInterrupt = (): void => {
		cleanup();
	};

	const done = new Promise<number>((resolve) => {
		finish = () => resolve(0);
	});

	try {
		stdout.write(
			ENTER_ALTERNATE_SCREEN + CURSOR_BLINKING_BAR + HIDE_CURSOR + ENABLE_FOCUS_REPORTING + ENABLE_MOUSE,
		);
		stdin.setRawMode?.(true);
		stdin.resume();
		stdout.on("resize", render);
		stdin.on("data", onData);
		process.on("SIGINT", onInterrupt);
		render();
	} catch (error) {
		cleanup();
		throw error;
	}

	return done;
}

function terminalHeight(output: TuiOutput): number {
	return Math.max(1, output.rows ?? DEFAULT_ROWS);
}

/** 审批按键：y 放行，n / Enter / Esc 拒绝。 */
function approvalKey(text: string): boolean | undefined {
	const lower = text.toLowerCase();
	if (lower.includes("y")) return true;
	if (lower.includes("n") || text.includes("\r") || text.includes("\n") || text === "\x1b") {
		return false;
	}
	return undefined;
}

/** 工具参数只显示个大概；完整内容由权限门自己截断后展示。 */
function summarizeArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 菜单打开时只认这四个键；普通字符与鼠标事件一律忽略。 */
function menuKey(text: string): "up" | "down" | "enter" | "escape" | undefined {
	if (text.includes("\x1b[A") || text.includes("\x1bOA")) return "up";
	if (text.includes("\x1b[B") || text.includes("\x1bOB")) return "down";
	if (text.includes("\r") || text.includes("\n")) return "enter";
	if (text === "\x1b") return "escape";
	return undefined;
}

function moveCursor(row: number, column: number): string {
	return `\x1b[${row};${column}H`;
}

function estimateTokens(text: string): number {
	let wide = 0;
	for (const char of text) {
		if (eastAsianWidth(char.codePointAt(0) ?? 0) === 2) wide += 1;
	}
	return wide + Math.ceil((text.length - wide) / 4);
}

/** 去掉 SGR 鼠标事件，避免它们被当成普通输入。 */
function stripMouseEvents(text: string): string {
	return text.replace(/\x1b\[<[0-9;]+[Mm]/g, "");
}

interface MouseInput {
	readonly button: number;
	readonly column: number;
	readonly row: number;
	/** SGR 的 M 表示按下，m 表示松开 */
	readonly press: boolean;
}

function mouseEvents(text: string): readonly MouseInput[] {
	const events: MouseInput[] = [];
	for (const match of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
		events.push({
			button: Number(match[1]),
			column: Number(match[2]),
			row: Number(match[3]),
			press: match[4] === "M",
		});
	}
	return events;
}

function scrollTopFromRow(row: number, height: number, maxScroll: number): number {
	if (maxScroll === 0 || height <= 1) return 0;

	const clamped = Math.min(Math.max(1, row), height);
	return Math.round(((clamped - 1) / (height - 1)) * maxScroll);
}

/**
 * 把终端读到的字符并进输入框。
 *
 * 光标固定在最末，因此退格就是删掉最后一个字符；回车表示发送；方向键等转义序列整段丢弃，
 * 不能当成文字填进去。转义序列通常在一次读取里完整到达，所以状态只需在这次调用内保持。
 */
function appendInput(current: string, chunk: string): { text: string; submit: boolean } {
	let next = current;
	let submit = false;
	let escape: "none" | "escape" | "csi" | "ss3" = "none";

	for (const char of chunk) {
		if (escape === "escape") {
			if (char === "[") escape = "csi";
			else if (char === "O") escape = "ss3";
			else escape = "none";
			continue;
		}
		if (escape === "csi") {
			if (char >= "@" && char <= "~") escape = "none";
			continue;
		}
		if (escape === "ss3") {
			escape = "none";
			continue;
		}
		if (char === "\x1b") {
			escape = "escape";
			continue;
		}
		if (char === "\r" || char === "\n") {
			submit = true;
			break;
		}
		if (char === "\x7f" || char === "\b") {
			next = next.replace(/.$/u, "");
			continue;
		}
		if (char >= " ") next += char;
	}

	return { text: next, submit };
}
