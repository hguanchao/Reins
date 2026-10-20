import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { AgentEvent, AgentEventListener } from "../agent/events.ts";
import { inputView, renderFooter, type FooterInfo } from "./footer.ts";
import { THINKING_LEVELS, type NotifyMode, type ThinkingLevel } from "../config/config-file.ts";
import type { ApprovalBroker, ApprovalPrompt } from "../permission/approval.ts";
import type { ApprovalAnswer } from "../permission/policy.ts";
import { describeToolCall, displayToolName } from "../tools/describe.ts";
import { formatDuration } from "../tools/format.ts";
import { resultDetail, resultMetric } from "../tools/result-summary.ts";
import { renderMain } from "./main.ts";
import { THEME } from "./theme.ts";
import { APPROVAL_PANEL_HEIGHT, approvalActionAt, renderApprovalPanel } from "./approval-panel.ts";
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
import { keepVisible, MENU_MAX_VISIBLE } from "./menu-panel.ts";
import { helpPageLines, renderHelpPage } from "./help-page.ts";
import { appendToolLine, buildTranscriptView, collapseToolGroups, findToolByCallId, measureTranscriptView, renderTranscriptView, scrollbarColumn, thinkingHeaderInView, toggleLastExpandable, toggleLastToolResult, toolGroupHeaderInView, toolHeaderInView, type TranscriptLine, type TranscriptThinking, type TranscriptTool, type TranscriptTurn, type TranscriptView } from "./transcript.ts";

/**
 * 全屏启动。
 *
 * 进入终端的备用屏，按当前尺寸铺满整个窗口；尺寸变化时重画。页脚是带运行时状态、输入框与
 * 常驻信息行的区域。回车把输入交给 TurnDriver，模型文本、工具调用与压缩进度作为事件实时
 * 进入对话流。输入 / 时展开命令补全面板，/model 与 /effort 再展开选择面板，/compact 立即
 * 压缩上下文，/help 把主区域换成整屏帮助页。工具需要确认时用审批面板替换输入区与页脚，
 * 对话流高度保持不变；审批结束后输入区与页脚恢复。一轮进行中 Ctrl+C 只中止当前轮，空闲时
 * 连按两次才退出。
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
/** 粘贴多行内容时不把换行当成提交。 */
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
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
/** 同一位置两次按下在这个窗口内算双击。 */
const DOUBLE_CLICK_MS = 400;

const WAITING_FOR_RESPONSE = "Waiting for response...";
const THINKING = "Thinking...";
const WRITING_RESPONSE = "Writing response...";
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
	response: TranscriptLine[];
}

/** 一轮正在进行的对话。 */
interface ActiveTurn {
	readonly turn: LiveTurn;
	readonly controller: AbortController;
	readonly startedAt: number;
	/** 已经完成的文本与工具行 */
	readonly lines: TranscriptLine[];
	/** 当前还没等到换行的文本 */
	partial: string;
	/** 当前这段思考是什么时候开始的；没有思考在进行时为空 */
	thinkingStartedAt: number | undefined;
	/** 当前正在写入的思考区块；结束后仍留在 lines 里供双击展开 */
	thinkingBlock: TranscriptThinking | undefined;
	/** 本轮已经产生的 token 消耗；每次请求回报后累加，压缩请求不计入 */
	tokensUsed: number;
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

/** 插件与宿主注册的斜杠命令；由装配处桥接到 PluginHost。 */
export interface PluginCommandSource {
	/** 当前可用的命令；每次重算补全时重新取，热重载后能看到变化 */
	readonly list: () => readonly CommandMenuItem[];
	/** 执行命令并返回要显示在对话流里的输出行；失败时抛错 */
	readonly run: (name: string, args: string) => Promise<readonly string[]>;
}

/** 真实对话入口；由启动装配提供。 */
export interface AgentRuntime {
	/** 跑一轮对话，事件驱动界面；signal 用于 Ctrl+C 中止。 */
	readonly runTurn: (
		prompt: string,
		onEvent: AgentEventListener,
		signal: AbortSignal,
	) => Promise<void>;
	/** 立即压缩上下文；不提供时 /compact 不可用。事件与普通对话共用一套。 */
	readonly compact?: (onEvent: AgentEventListener, signal: AbortSignal) => Promise<void>;
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
	/** 插件与宿主注册的斜杠命令；不提供时只有内置命令 */
	readonly pluginCommands?: PluginCommandSource;
	/** 一轮结束时的提醒方式；默认 auto（失焦时响铃） */
	readonly notify?: NotifyMode;
	/** 启动时回填的历史对话；续聊时使用 */
	readonly history?: readonly TranscriptTurn[];
	/** 工作根：用来判断命令开头的工作根 cd 是否多余，省略时原样显示 */
	readonly workspaceRoot?: string;
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
	const builtinCommands: readonly CommandMenuItem[] = [
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
			name: "compact",
			description:
				options.agent?.compact === undefined
					? "Requires a valid configuration"
					: "Compress the conversation context into a summary now",
			enabled: options.agent?.compact !== undefined,
		},
		{
			name: "help",
			description: "Show the commands and keys",
			enabled: true,
		},
	];

	/** 内置命令 + 当前插件命令；同名时内置优先，插件不能顶掉 /model 这类入口。 */
	const commands = (): readonly CommandMenuItem[] => {
		const plugin = options.pluginCommands?.list() ?? [];
		const names = new Set(builtinCommands.map((command) => command.name));
		return [...builtinCommands, ...plugin.filter((command) => !names.has(command.name))];
	};

	let input = "";
	let inputCursor = 0;
	/** 输入历史：只在本次界面会话里保留。 */
	const inputHistory: string[] = [];
	let historyIndex = -1;
	let historyDraft = "";
	/** bracketed paste 可能跨多个数据块，记住是否还在粘贴中。 */
	let pasting = false;
	const setInput = (value: string, cursor = value.length): void => {
		input = value;
		inputCursor = Math.min(Math.max(0, cursor), value.length);
	};
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
	/** 上一次左键按下的位置与时间，用于识别双击。 */
	let lastClick: { at: number; row: number; column: number } | undefined;
	/** 是否跟随新内容滚到底部。 */
	let follow = true;
	/** 滚上去之后又有新输出，底部显示回底提示。 */
	let newOutput = false;
	/** 对话流构建缓存：同一内容只换行一次，测量、绘制与命中共用。 */
	let transcriptView: TranscriptView | undefined;
	let transcriptViewWidth = -1;
	let transcriptViewNotice: string | undefined;
	let transcriptDirty = true;
	/** 是否正按住滚动条拖动。 */
	let draggingScrollbar = false;
	/** 当前运行时状态；为空表示空闲。 */
	let statusText: string | undefined;
	/** 状态是不是失败结局；失败用错误色，别跟「正在进行」混成一样。 */
	let statusTone: "error" | undefined;
	let statusPhaseMs = 0;
	let statusElapsedMs = 0;
	let statusTokens = 0;
	let statusPhaseStartedAt = 0;
	let spinnerFrame = 0;
	let sweepPhase = 0;
	let activeTurn: ActiveTurn | undefined;
	let approvalPrompt: ApprovalPrompt | undefined;
	/** 动作行当前高亮的选项；默认允许一次，直接回车就是放行 */
	let approvalSelection: ApprovalAnswer = "once";
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

	/** 一轮结束的提醒。auto 只在终端失焦时响铃；desktop 在 macOS/Linux 调系统通知。 */
	const notify = (message: string): void => {
		const mode = options.notify ?? "auto";
		if (mode === "off") return;
		if (mode === "auto" && focused) return;
		if (mode === "desktop" && process.platform !== "win32") {
			desktopNotify(message);
			return;
		}
		stdout.write("\x07");
	};
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
	const inputLineCount = (): number => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		return inputView(input, width, inputCursor).lines.length;
	};
	const footerHeight = (): number => {
		if (approvalPrompt !== undefined) return APPROVAL_PANEL_HEIGHT;
		// 帮助页是整屏页面，不保留输入框与常驻信息
		if (helpOpen) return 0;
		const lines = inputLineCount();
		if (!compactFooter()) return 5 + lines;
		return 3 + lines + menuHeight();
	};

	const markTranscriptDirty = (): void => {
		transcriptDirty = true;
	};

	/** 新内容进对话流；用户已经滚上去时顺便点亮回底提示。 */
	const markNewContent = (): void => {
		transcriptDirty = true;
		if (!follow) newOutput = true;
	};

	/** 宽度、警告或内容变化时重建；其余帧直接复用。 */
	const currentTranscript = (width: number): TranscriptView => {
		if (
			transcriptView === undefined ||
			transcriptDirty ||
			transcriptViewWidth !== width ||
			transcriptViewNotice !== activeWarning
		) {
			transcriptView = buildTranscriptView(width, turns, activeWarning);
			transcriptViewWidth = width;
			transcriptViewNotice = activeWarning;
			transcriptDirty = false;
		}
		return transcriptView;
	};

	const render = (): void => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const height = terminalHeight(stdout);
		const mainHeight = Math.max(0, height - footerHeight());
		const view = currentTranscript(width);
		const metrics = measureTranscriptView(view, mainHeight);
		const maxScroll = Math.max(0, metrics.scrollLines - mainHeight);
		if (initialScroll || follow) {
			scrollTop = maxScroll;
			initialScroll = false;
		} else {
			scrollTop = Math.min(scrollTop, maxScroll);
		}

		const status =
			statusText === undefined
				? undefined
				: {
						// 失败结局不带转圈符号也不扫光：那两样都表示还在动，出错时它已经停了
						symbol: statusTone === "error" ? "" : (SPINNER_FRAMES[spinnerFrame] ?? ""),
						text: statusText,
						sweep: statusTone === "error" ? undefined : sweepPhase,
						tone: statusTone,
						phaseMs: statusPhaseMs,
						elapsedMs: statusElapsedMs,
						tokens: statusTokens,
					};
		const menuLines =
			approvalPrompt !== undefined
				? renderApprovalPanel(width, approvalPrompt, approvalSelection)
				: modelMenu !== undefined
					? renderModelMenu(width, modelMenu)
					: effortMenu !== undefined
						? renderEffortMenu(width, effortMenu)
						: commandMenu !== undefined
							? renderCommandMenu(width, commandMenu)
							: [];
		const inputLines = inputView(input, width, inputCursor);
		const footer =
			helpOpen || approvalPrompt !== undefined
				? []
				: compactFooter()
					? renderFooter(
							width,
							input,
							focused &&
								modelMenu === undefined &&
								effortMenu === undefined &&
								!helpOpen,
							undefined,
							currentInfo(),
							{ leadingGap: false, showStatus: false, cursor: inputCursor },
						)
					: renderFooter(width, input, focused, status, currentInfo(), {
							cursor: inputCursor,
						});
		const transcriptShown = !helpOpen && (hasInput || activeWarning !== undefined);
		const main = helpOpen
			? renderHelpPage(helpPageLines(width, commands()), mainHeight, helpScrollTop)
			: transcriptShown
				? renderTranscriptView(view, mainHeight, scrollTop)
				: renderMain(width, mainHeight, options.version);
		const mainLines = [...main];
		if (transcriptShown && newOutput && mainHeight > 0) {
			const hint = "↓ new output · Ctrl+End to jump".slice(0, width);
			mainLines[mainHeight - 1] =
				`${THEME.warning}${hint}${THEME.reset}${" ".repeat(Math.max(0, width - hint.length))}`;
		}
		// 整屏自上而下：主区域、面板、页脚；终端比内容矮时只保留前几行
		const lines = [...mainLines, ...menuLines, ...footer].slice(0, height);
		const inputRow = compactFooter()
			? mainHeight + menuHeight() + 2 + inputLines.row
			: mainHeight + 4 + inputLines.row;
		const cursor =
			focused &&
			!helpOpen &&
			modelMenu === undefined &&
			effortMenu === undefined &&
			approvalPrompt === undefined &&
			inputRow <= height
				? moveCursor(inputRow, inputLines.column) + SHOW_CURSOR
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
			const gutter = scrollbarColumn(mainHeight, metrics.totalLines, scrollTop);
			for (let row = 0; row < gutter.length; row += 1) {
				frame += `${moveCursor(row + 1, width)}${gutter[row]}`;
			}
		}
		stdout.write(frame + cursor);
	};

	const maxScroll = (): number => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		const mainHeight = Math.max(0, terminalHeight(stdout) - footerHeight());
		return Math.max(0, measureTranscriptView(currentTranscript(width), mainHeight).scrollLines - mainHeight);
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
		stdout.write(
			DISABLE_BRACKETED_PASTE +
				DISABLE_MOUSE +
				DISABLE_FOCUS_REPORTING +
				CURSOR_DEFAULT +
				SHOW_CURSOR +
				LEAVE_ALTERNATE_SCREEN,
		);
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

	const setStatus = (text: string, tone?: "error"): void => {
		statusText = text;
		statusTone = tone;
		statusPhaseMs = 0;
		statusPhaseStartedAt = Date.now();
	};

	/** 立即清空运行状态。完成后不保留额外的提示，回复本身就是结束信号。 */
	const clearStatus = (): void => {
		statusText = undefined;
		statusPhaseMs = 0;
		statusElapsedMs = 0;
		statusTokens = 0;
	};

	const scheduleStatusClear = (): void => {
		if (statusClearTimer !== undefined) clearTimeout(statusClearTimer);
		statusClearTimer = setTimeout(() => {
			statusClearTimer = undefined;
			clearStatus();
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
					approvalPrompt.tool !== next.tool ||
					approvalPrompt.risk !== next.risk ||
					approvalPrompt.detail !== next.detail ||
					approvalPrompt.saveShort !== next.saveShort;
		if (next !== undefined && changed) {
		approvalSelection = "once";
	}
		approvalPrompt = next;
		return changed;
	};

	/** 把结论交回权限门；下一个排队请求若存在会立即顶上来，并重置为默认允许一次。 */
	const resolveApproval = (answer: ApprovalAnswer): void => {
		options.approval?.resolve(answer);
		approvalPrompt = undefined;
		syncApprovalPrompt();
		render();
	};

	/** 左右键在当前可用的动作之间移动高亮。 */
	const moveApprovalSelection = (delta: number): void => {
		if (approvalPrompt === undefined) return;
		const actions: ApprovalAnswer[] =
			approvalPrompt.saveShort === undefined ? ["once", "deny"] : ["once", "always", "deny"];
		let index = actions.indexOf(approvalSelection);
		if (index < 0) index = 0;
		approvalSelection =
			actions[Math.min(actions.length - 1, Math.max(0, index + delta))] ?? "once";
		render();
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
				statusTokens = activeTurn.tokensUsed;
				syncApprovalPrompt();
			}
			render();
		}, SPINNER_INTERVAL_MS);
	};

	const syncTurn = (active: ActiveTurn): void => {
		const response = active.turn.response;
		// 流式增量只追加新完成的行；整份数组复制会让每个 token 都随历史长度线性变慢
		if (response.length > active.lines.length) response.length = active.lines.length;
		for (let index = response.length; index < active.lines.length; index += 1) {
			response.push(active.lines[index]!);
		}
		if (active.partial.length > 0) response.push(active.partial);
		markNewContent();
	};

	/** 工具行被换成组对象时，另一份数组里的引用也要整体替换。 */
	const syncTurnFull = (active: ActiveTurn): void => {
		const response = active.turn.response;
		response.length = 0;
		response.push(...active.lines);
		if (active.partial.length > 0) response.push(active.partial);
		markNewContent();
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
	};

	/** 思考正文按行实时写入当前区块；最后一段未换行的内容作为临时行显示。 */
	const appendThinkingText = (active: ActiveTurn, delta: string): void => {
		const block = active.thinkingBlock;
		if (block === undefined) return;
		block.partial += delta;
		const parts = block.partial.split("\n");
		block.partial = parts.pop() ?? "";
		block.body.push(...parts);
		syncTurn(active);
	};

	const appendLine = (active: ActiveTurn, line: TranscriptLine): void => {
		flushPartial(active);
		active.lines.push(line);
		syncTurn(active);
	};

	/**
	 * 一段思考结束。
	 *
	 * 正文保留在区块里，但默认收起：运行中显示最后五行，结束后只显示标题。双击标题可在
	 * 全文和默认状态之间切换。
	 */
	const closeThinking = (active: ActiveTurn): void => {
		const startedAt = active.thinkingStartedAt;
		if (startedAt === undefined) return;

		active.thinkingStartedAt = undefined;
		const block = active.thinkingBlock;
		active.thinkingBlock = undefined;
		if (block !== undefined) {
			if (block.partial.length > 0) {
				block.body.push(block.partial);
				block.partial = "";
			}
			block.header = `Thought for ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
			block.running = false;
			block.expanded = false;
		}
		syncTurn(active);
	};

	const onEvent: AgentEventListener = (event: AgentEvent): void => {
		const active = activeTurn;
		if (active === undefined) return;

		switch (event.type) {
			case "turn_start":
				setStatus(WAITING_FOR_RESPONSE);
				break;
			case "text_delta":
				closeThinking(active);
				appendAssistantText(active, event.text);
				setStatus(WRITING_RESPONSE);
				break;
			case "reasoning_delta":
				// 思考开始：插入区块；正文实时写入，运行时默认只显示最后五行
				if (active.thinkingBlock === undefined) {
					active.thinkingStartedAt = Date.now();
					flushPartial(active);
					const block: TranscriptThinking = {
						kind: "thinkingBlock",
						header: "Thinking…",
						body: [],
						partial: "",
						running: true,
						expanded: false,
					};
					active.thinkingBlock = block;
					active.lines.push(block);
					syncTurn(active);
				}
				appendThinkingText(active, event.text);
				setStatus(THINKING);
				break;
			case "tool_start": {
				closeThinking(active);
				const described = describeToolCall(event.name, event.args, options.workspaceRoot);
				const tool: TranscriptTool = {
					kind: "tool",
					name: described.name,
					detail: described.detail,
					...(described.fullDetail === undefined ? {} : { fullDetail: described.fullDetail }),
					...(described.linkTarget === undefined ? {} : { linkTarget: described.linkTarget }),
					group: described.group,
					callId: event.callId,
				};
				flushPartial(active);
				if (appendToolLine(active.lines, tool, true)) syncTurnFull(active);
				else syncTurn(active);
				setStatus(`Running ${described.name}...`);
				break;
			}
			case "tool_update":
				setStatus("Running tool...");
				break;
			case "tool_end":
				// 成功不落行：工具调用本身已经显示；结果挂到调用行，Ctrl+O 可展开
				if (event.isError) {
					appendLine(active, {
						kind: "tool",
						name: displayToolName(event.name),
						detail: event.summary,
						isError: true,
						durationMs: event.durationMs,
					});
				} else {
					const tool = findToolByCallId(active.lines, event.callId);
					if (tool !== undefined) {
						tool.result = event.content ?? event.summary;
						const metric =
							event.name === "bash"
								? formatDuration(event.durationMs)
								: resultMetric(event.name, event.details, tool.result);
						if (metric !== undefined) tool.metric = metric;
						const detail = resultDetail(event.name, tool.result, event.details);
						if (detail !== undefined) {
							tool.fullDetail = detail.text;
							tool.detailKind = detail.kind;
						}
						markTranscriptDirty();
					}
				}
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
				appendLine(active, { text: `Error: ${event.message}`, kind: "error" });
				break;
			case "compaction_skipped":
				appendLine(active, `  ${event.message}`);
				break;
			case "usage_recorded":
				// 压缩请求花掉的 token 属于压缩成本，不算这一轮对话的用量
				if (event.kind === "turn") active.tokensUsed += event.tokens;
				statusTokens = active.tokensUsed;
				// 每次请求的用量都反映到页脚上，不必等整轮跑完
				options.agent?.refreshInfo();
				break;
			case "retrying":
				setStatus(`Retrying (${event.attempt})...`);
				break;
			case "error":
				closeThinking(active);
				appendLine(active, { text: `Error: ${event.message}`, kind: "error" });
				active.outcome = "error";
				setStatus(ERROR_STATUS, "error");
				break;
			case "aborted":
				closeThinking(active);
				appendLine(active, { text: "Error: aborted", kind: "error" });
				active.outcome = "aborted";
				setStatus(ABORTED, "error");
				break;
			case "turn_end":
				// 只思考、没产出正文也没调工具的一次请求，摘要行也要落下
				closeThinking(active);
				break;
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
			setInput("");
			turns.push({ prompt: "/model", response: ["No models are available."] });
			markNewContent();
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
		setInput("");

		if (item !== undefined && source !== undefined) {
			let response: TranscriptLine[];
			try {
				const result = source.select(item);
				ready = result.ready;
				activeWarning = result.warning;
				response = [
					`Model switched to ${item.provider}/${item.model}.`,
					...result.warnings.map((text) => ({ kind: "warning" as const, text })),
				];
			} catch (error) {
				response = [
					{
						kind: "error",
						text: `Error: Failed to switch model: ${error instanceof Error ? error.message : String(error)}`,
					},
				];
			}
			turns.push({ prompt: "/model", response });
			markNewContent();
			hasInput = true;
		}
		render();
	};

	const cancelMenu = (): void => {
		modelMenu = undefined;
		effortMenu = undefined;
		commandMenu = undefined;
		setInput("");
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
		setInput("");

		if (level !== undefined && source !== undefined) {
			let response: TranscriptLine[];
			try {
				source.select(level);
				response = [`Effort set to ${level}.`];
			} catch (error) {
				response = [
					{
						kind: "error",
						text: `Error: Failed to set effort: ${error instanceof Error ? error.message : String(error)}`,
					},
				];
			}
			turns.push({ prompt: "/effort", response });
			markNewContent();
			hasInput = true;
		}
		render();
	};

	const cancelEffortMenu = (): void => {
		effortMenu = undefined;
		modelMenu = undefined;
		setInput("");
		render();
	};

	/** 输入变化后重算命令补全列表；只匹配斜杠后不含空格的命令名。 */
	const updateCommandMenu = (): void => {
		if (modelMenu !== undefined) return;

		if (input.startsWith("/") && !input.slice(1).includes(" ")) {
			const query = input.slice(1).toLowerCase();
			const items = commands().filter(
				(command) =>
					command.name.toLowerCase().startsWith(query) ||
					command.description.toLowerCase().includes(query),
			);
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

	/**
	 * 启动一次由事件驱动的运行。
	 *
	 * 普通提问与 /compact 都走这里：一样的吸顶提示、状态行、转圈与收尾。差别只在交给 run 的
	 * 是什么——一次对话，还是一次压缩。
	 */
	const startRun = (
		prompt: string,
		run: (onEvent: AgentEventListener, signal: AbortSignal) => Promise<void>,
	): void => {
		const turn: LiveTurn = { prompt, response: [] };
		turns.push(turn);
		markTranscriptDirty();
		const active: ActiveTurn = {
			turn,
			controller: new AbortController(),
			startedAt: Date.now(),
			lines: [],
			partial: "",
			thinkingStartedAt: undefined,
			thinkingBlock: undefined,
			tokensUsed: 0,
			outcome: "done",
		};
		activeTurn = active;
		hasInput = true;
		follow = true;
		newOutput = false;
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
		scrollTop = measureTranscriptView(currentTranscript(width), mainHeight).lastPromptStart;
		startSpinner();
		render();

		void run(onEvent, active.controller.signal)
			.catch((error) => {
				if (finished || activeTurn !== active) return;
				closeThinking(active);
				appendLine(active, {
					text: `Error: ${error instanceof Error ? error.message : String(error)}`,
					kind: "error",
				});
				active.outcome = "error";
				setStatus(ERROR_STATUS, "error");
			})
			.finally(() => {
				if (activeTurn !== active) return;
				closeThinking(active);
				flushPartial(active);
				collapseToolGroups(active.lines);
				syncTurn(active);
				activeTurn = undefined;
				stopSpinner();
				options.approval?.denyAll();
				syncApprovalPrompt();
				if (finished) return;
				disarm();
				options.agent?.refreshInfo();
				statusElapsedMs = Date.now() - active.startedAt;
				statusTokens = active.tokensUsed;
				if (active.outcome === "done") {
					clearStatus();
				} else {
					setStatus(
						active.outcome === "aborted" ? ABORTED : ERROR_STATUS,
						"error",
					);
					scheduleStatusClear();
				}
				render();
				if (active.outcome !== "aborted") {
					notify(active.outcome === "done" ? "Turn complete" : "Turn failed");
				}
			});
	};

	/**
	 * 执行插件/宿主命令。
	 *
	 * 命令不产生模型事件，因此单独建一条对话流记录；print 的输出原样放进去，失败按错误行显示。
	 */
	const runPluginCommand = (command: CommandMenuItem, args: string): void => {
		const source = options.pluginCommands;
		if (source === undefined) return;

		const turn: LiveTurn = { prompt: `/${command.name}`, response: [] };
		turns.push(turn);
		markTranscriptDirty();
		hasInput = true;
		follow = true;
		newOutput = false;
		statusElapsedMs = 0;
		statusTokens = 0;
		if (statusClearTimer !== undefined) {
			clearTimeout(statusClearTimer);
			statusClearTimer = undefined;
		}
		setStatus(`Running /${command.name}...`);
		render();

		void source
			.run(command.name, args)
			.then((lines) => {
				if (finished) return;
				turn.response.push(...lines);
				markNewContent();
				clearStatus();
				render();
				notify(`/${command.name} finished`);
			})
			.catch((error) => {
				if (finished) return;
				turn.response.push({
					text: `Error: ${error instanceof Error ? error.message : String(error)}`,
					kind: "error",
				});
				markNewContent();
				setStatus(ERROR_STATUS, "error");
				render();
				notify(`/${command.name} failed`);
			});
	};

	const executeCommand = (command: CommandMenuItem, args = ""): void => {
		commandMenu = undefined;
		// 从补全面板执行时把输入补全成完整命令，面板打开期间看得清当前在做什么
		setInput(`/${command.name}`);

		if (command.name === "model") {
			if (options.modelMenu === undefined) {
				setInput("");
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
				setInput("");
				statusElapsedMs = 0;
				statusTokens = 0;
				setStatus(CONFIGURATION_REQUIRED);
				render();
				return;
			}
			openEffortMenu();
			return;
		}

		if (command.name === "compact") {
			const compact = options.agent?.compact;
			setInput("");
			if (compact === undefined) {
				statusElapsedMs = 0;
				statusTokens = 0;
				setStatus(CONFIGURATION_REQUIRED);
				render();
				return;
			}
			startRun("/compact", compact);
			return;
		}

		if (command.name === "help") {
			// 命令名不留在输入框里：帮助页期间输入框不接受按键
			setInput("");
			helpOpen = true;
			helpScrollTop = 0;
			render();
			return;
		}

		// 未覆盖的插件命令交给宿主执行
		setInput("");
		if (options.pluginCommands !== undefined) {
			runPluginCommand(command, args);
			return;
		}
		render();
	};

	/** 按命令名查找；命令名之后的文字是参数。 */
	const findCommand = (message: string): CommandMenuItem | undefined => {
		if (!message.startsWith("/")) return undefined;
		const name = message.slice(1).split(/\s/, 1)[0] ?? "";
		return commands().find((item) => item.name === name);
	};

	const commandArgs = (message: string, name: string): string => {
		return message.slice(name.length + 1).trim();
	};

	const rememberInput = (value: string): void => {
		const text = value.trim();
		if (text.length === 0) return;
		if (inputHistory.at(-1) !== text) inputHistory.push(text);
		if (inputHistory.length > 100) inputHistory.shift();
		historyIndex = -1;
	};

	const recallHistory = (delta: -1 | 1): boolean => {
		if (inputHistory.length === 0) return false;
		if (delta < 0) {
			if (historyIndex === -1) {
				historyDraft = input;
				historyIndex = inputHistory.length;
			}
			if (historyIndex > 0) historyIndex -= 1;
		} else {
			if (historyIndex === -1) return false;
			historyIndex += 1;
			if (historyIndex >= inputHistory.length) {
				historyIndex = -1;
				setInput(historyDraft);
				updateCommandMenu();
				render();
				return true;
			}
		}
		setInput(inputHistory[historyIndex] ?? "");
		updateCommandMenu();
		render();
		return true;
	};

	/** 回车发送：把输入交给真实 TurnDriver，事件驱动对话流与状态行。 */
	const submit = (): boolean => {
		if (input.length === 0) return false;
		// 一轮进行中不接受新提交；状态行继续显示当前进度
		if (activeTurn !== undefined) return false;

		const message = input.trim();
		if (message.length === 0) return false;
		rememberInput(message);
		const selected = commandMenu?.items[commandMenu.cursor];
		const command = selected ?? findCommand(message);
		if (message.startsWith("/") && command !== undefined) {
			// 命令先于受限检查执行：/model 正是用来修复配置对不上的入口
			executeCommand(command, selected === undefined ? commandArgs(message, command.name) : "");
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

		setInput("");
		if (message.length === 0) return false;

		startRun(message, (onEvent, signal) => agent.runTurn(message, onEvent, signal));
		return true;
	};

	const onData = (chunk: Buffer): void => {
		const text = decoder.write(chunk);
		if (text.includes(CTRL_C)) {
			onCtrlC();
			return;
		}

		if (approvalPrompt !== undefined) {
			// 审批是模态的：鼠标可点动作；键盘左右移动、回车确认，y/a/n 直接执行，Esc 拒绝
			const panelWidth = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
			const panelHeight = terminalHeight(stdout);
			const panelTop = Math.max(0, panelHeight - footerHeight());
			for (const event of mouseEvents(text)) {
				const motion = event.button >= 32 && event.button < 64;
				const action =
					event.row === panelTop + 5
						? approvalActionAt(panelWidth, approvalPrompt, event.column - 1)
						: undefined;
				if (motion) {
					if (action !== undefined && action !== approvalSelection) {
						approvalSelection = action;
						render();
					}
					continue;
				}
				if (!event.press || (event.button & 3) !== 0) continue;
				if (action !== undefined) {
					resolveApproval(action);
					return;
				}
			}

			const key = approvalKey(text, approvalPrompt.saveShort !== undefined);
			if (key === "left") {
				moveApprovalSelection(-1);
				return;
			}
			if (key === "right") {
				moveApprovalSelection(1);
				return;
			}
			if (key === "enter") {
				resolveApproval(approvalSelection);
				return;
			}
			if (key === "escape") {
				resolveApproval("deny");
				return;
			}
			if (key !== undefined) resolveApproval(key);
			return;
		}

		if (modelMenu !== undefined || effortMenu !== undefined) {
			// 选择面板是模态的：上下键、回车、Esc 与鼠标点击都可用
			const panelsHeight = terminalHeight(stdout);
			const panelTop = Math.max(0, panelsHeight - footerHeight());
			for (const event of mouseEvents(text)) {
				const motion = event.button >= 32 && event.button < 64;
				if (modelMenu !== undefined) {
					const index = menuIndexAtRow(
						event.row,
						panelTop,
						modelMenu.items.length,
						modelMenu.scrollTop,
						modelMenu.cursor,
					);
					if (motion) {
						if (index !== undefined && index !== modelMenu.cursor) {
							modelMenu.cursor = index;
							keepMenuCursor();
							render();
							return;
						}
						continue;
					}
					if (event.press && event.button === 64) {
						moveMenu(-1);
						return;
					}
					if (event.press && event.button === 65) {
						moveMenu(1);
						return;
					}
					if (event.press && (event.button & 3) === 0 && index !== undefined) {
						modelMenu.cursor = index;
						confirmMenu();
						return;
					}
				} else if (effortMenu !== undefined) {
					const index = menuIndexAtRow(
						event.row,
						panelTop,
						THINKING_LEVELS.length,
						effortMenu.scrollTop,
						effortMenu.cursor,
					);
					if (motion) {
						if (index !== undefined && index !== effortMenu.cursor) {
							effortMenu.cursor = index;
							render();
							return;
						}
						continue;
					}
					if (event.press && event.button === 64) {
						moveEffortMenu(-1);
						return;
					}
					if (event.press && event.button === 65) {
						moveEffortMenu(1);
						return;
					}
					if (event.press && (event.button & 3) === 0 && index !== undefined) {
						effortMenu.cursor = index;
						confirmEffortMenu();
						return;
					}
				}
			}

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
			const total = helpPageLines(width, commands()).length;
			let steps = 0;
			for (const event of mouseEvents(text)) {
				if (event.press && event.button === 64) steps -= 1;
				else if (event.press && event.button === 65) steps += 1;
			}
			const key = menuKey(text);
			if (key === "up") steps -= 1;
			if (key === "down") steps += 1;
			const page = scrollKey(text);
			if (page === "pageUp") steps -= rows;
			if (page === "pageDown") steps += rows;
			if (page === "top") helpScrollTop = 0;
			if (page === "bottom") helpScrollTop = Math.max(0, total - rows);

			if (key === "escape") {
				helpOpen = false;
				render();
				return;
			}
			if (page === "top" || page === "bottom") {
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
				const now = Date.now();
				const doubleClick =
					lastClick !== undefined &&
					now - lastClick.at <= DOUBLE_CLICK_MS &&
					lastClick.row === event.row &&
					lastClick.column === event.column;
				lastClick = { at: now, row: event.row, column: event.column };

				// 双击思考标题展开/收起；滚动条列和页脚不参与
				if (
					doubleClick &&
					event.row <= mainHeight &&
					event.column < width - 1
				) {
					const view = currentTranscript(width);
					const block = thinkingHeaderInView(view, mainHeight, scrollTop, event.row);
					if (block !== undefined) {
						block.expanded = !block.expanded;
						markTranscriptDirty();
						lastClick = undefined;
						// 保持标题在点击时的屏幕位置：跟随到底部会让长内容直接跳到末尾
						follow = false;
						render();
						return;
					}

					const group = toolGroupHeaderInView(view, mainHeight, scrollTop, event.row);
					if (group !== undefined) {
						group.expanded = !group.expanded;
						markTranscriptDirty();
						lastClick = undefined;
						follow = false;
						render();
						return;
					}

					const tool = toolHeaderInView(view, mainHeight, scrollTop, event.row);
					if (tool !== undefined) {
						tool.detailExpanded = !(tool.detailExpanded ?? false);
						markTranscriptDirty();
						lastClick = undefined;
						follow = false;
						render();
						return;
					}
				}

				const inputLineTotal = inputView(input, width, inputCursor).lines.length;
				const inputTop =
					height -
					(compactFooter() ? 3 + inputLineTotal : 5 + inputLineTotal) +
					(compactFooter() ? 2 : 4);
				const insideInput =
					event.row >= inputTop && event.row < inputTop + inputLineTotal;
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
			const limit = maxScroll();
			scrollTop = Math.min(limit, Math.max(0, scrollTop + wheelSteps * WHEEL_STEP));
			follow = scrollTop >= limit;
			if (follow) newOutput = false;
		}
		if (dragRow !== undefined) {
			const limit = maxScroll();
			scrollTop = scrollTopFromRow(dragRow, mainHeight, limit);
			follow = scrollTop >= limit;
			if (follow) newOutput = false;
		}
		const scrollChanged = scrollTop !== beforeScroll;

		if (commandMenu !== undefined) {
			// 命令补全面板不拦截文字输入，只接管上下键、Esc 与鼠标
			const commandPanelTop = Math.max(0, terminalHeight(stdout) - footerHeight());
			for (const event of mouseEvents(text)) {
				const motion = event.button >= 32 && event.button < 64;
				const index = menuIndexAtRow(
					event.row,
					commandPanelTop,
					commandMenu.items.length,
					commandMenu.scrollTop,
					commandMenu.cursor,
				);
				if (motion) {
					if (index !== undefined && index !== commandMenu.cursor) {
						commandMenu.cursor = index;
						commandMenu.scrollTop = keepVisible(
							commandMenu.scrollTop,
							commandMenu.cursor,
							commandMenu.items.length,
						);
						render();
						return;
					}
					continue;
				}
				if (event.press && event.button === 64) {
					moveCommandMenu(-1);
					return;
				}
				if (event.press && event.button === 65) {
					moveCommandMenu(1);
					return;
				}
				if (event.press && (event.button & 3) === 0 && index !== undefined) {
					commandMenu.cursor = index;
					submit();
					return;
				}
			}

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
		const previousCursor = inputCursor;
		if (text === "\x05" && commandMenu === undefined) {
			if (toggleLastExpandable(turns)) {
				markTranscriptDirty();
				follow = false;
				render();
			}
			return;
		}
		if (text === "\x0f" && commandMenu === undefined) {
			if (toggleLastToolResult(turns)) {
				markTranscriptDirty();
				follow = false;
				render();
			}
			return;
		}
		const scroll = scrollKey(text);
		if (scroll !== undefined) {
			const limit = maxScroll();
			if (scroll === "pageUp") {
				scrollTop = Math.max(0, scrollTop - mainHeight);
				follow = false;
			} else if (scroll === "pageDown") {
				scrollTop = Math.min(limit, scrollTop + mainHeight);
				follow = scrollTop >= limit;
			} else if (scroll === "top") {
				scrollTop = 0;
				follow = false;
			} else {
				scrollTop = limit;
				follow = true;
			}
			if (follow) newOutput = false;
			render();
			return;
		}

		const step = historyKey(withoutMouse);
		if (step !== undefined && commandMenu === undefined) {
			if (input.includes("\n")) {
				const moved = moveInputVertical(input, inputCursor, step);
				if (moved !== undefined && moved !== inputCursor) {
					setInput(input, moved);
					render();
					return;
				}
			}
			if (recallHistory(step)) return;
		}

		const edit = editInput(input, inputCursor, withoutMouse, pasting);
		pasting = edit.pasting;
		if (edit.text !== previous) historyIndex = -1;
		setInput(edit.text, edit.cursor);
		updateCommandMenu();
		// 配置不可用时主区域要一直保留警告，不能因为敲了字就切到对话流；
		// 斜杠命令同样不是对话内容，补全面板与帮助页都盖在启动画面上
		if (input.length > 0 && !input.startsWith("/") && ready) hasInput = true;

		if (edit.submit) {
			const submitted = submit();
			if (!submitted && (focusChanged || scrollChanged)) render();
			return;
		}
		if (input !== previous || inputCursor !== previousCursor || edit.handled || focusChanged || scrollChanged) {
			render();
		}
	};

	const onInterrupt = (): void => {
		cleanup();
	};

	const done = new Promise<number>((resolve) => {
		finish = () => resolve(0);
	});

	try {
		stdout.write(
			ENTER_ALTERNATE_SCREEN +
				CURSOR_BLINKING_BAR +
				HIDE_CURSOR +
				ENABLE_FOCUS_REPORTING +
				ENABLE_MOUSE +
				ENABLE_BRACKETED_PASTE,
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

/**
 * 桌面通知。
 *
 * 只覆盖有标准命令的 macOS 与 Linux；Windows 上由调用方退回终端响铃，不依赖额外的运行时。
 */
function desktopNotify(message: string): void {
	const title = "Reins";
	const child =
		process.platform === "darwin"
			? spawn(
					"osascript",
					["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
					{ stdio: "ignore", windowsHide: true },
				)
			: spawn("notify-send", [title, message], { stdio: "ignore", windowsHide: true });
	// 系统没有对应命令时静默忽略：通知不该影响对话本身
	child.on("error", () => {});
}

function terminalHeight(output: TuiOutput): number {
	return Math.max(1, output.rows ?? DEFAULT_ROWS);
}

type ApprovalKey = ApprovalAnswer | "left" | "right" | "enter" | "escape";

/** 审批按键：左右移动、回车确认；y/a/n 仍可直接执行，Esc 拒绝。 */
function approvalKey(text: string, canAlways: boolean): ApprovalKey | undefined {
	if (text.includes("\x1b[D") || text.includes("\x1bOD")) return "left";
	if (text.includes("\x1b[C") || text.includes("\x1bOC")) return "right";
	if (text.includes("\r") || text.includes("\n")) return "enter";
	if (text === "\x1b") return "escape";

	const lower = text.toLowerCase();
	if (lower.includes("y")) return "once";
	if (canAlways && lower.includes("a")) return "always";
	if (lower.includes("n")) return "deny";
	return undefined;
}

/** 菜单打开时只认这四个键；普通字符与鼠标事件一律忽略。 */
function menuKey(text: string): "up" | "down" | "enter" | "escape" | undefined {
	if (text.includes("\x1b[A") || text.includes("\x1bOA")) return "up";
	if (text.includes("\x1b[B") || text.includes("\x1bOB")) return "down";
	if (text.includes("\r") || text.includes("\n")) return "enter";
	if (text === "\x1b") return "escape";
	return undefined;
}

/** 输入历史只认完整的方向键序列，避免把粘贴内容里的序列当成翻历史。 */
function historyKey(text: string): -1 | 1 | undefined {
	if (text === "\x1b[A" || text === "\x1bOA") return -1;
	if (text === "\x1b[B" || text === "\x1bOB") return 1;
	return undefined;
}

/** 对话流滚动键；不与输入行的 Home/End 抢按键。 */
function scrollKey(text: string): "pageUp" | "pageDown" | "top" | "bottom" | undefined {
	if (text === "\x1b[5~") return "pageUp";
	if (text === "\x1b[6~") return "pageDown";
	if (text === "\x1b[1;5H" || text === "\x1b[1;5F") {
		return text.endsWith("H") ? "top" : "bottom";
	}
	return undefined;
}

function moveCursor(row: number, column: number): string {
	return `\x1b[${row};${column}H`;
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

/** 菜单面板的屏幕行对应哪个条目；top 是面板第一行的 0 基坐标。 */
function menuIndexAtRow(
	row: number,
	panelTop: number,
	itemCount: number,
	scrollTop: number,
	cursor: number,
): number | undefined {
	const visible = Math.min(Math.max(0, itemCount), MENU_MAX_VISIBLE);
	if (visible === 0) return undefined;
	const offset = row - (panelTop + 2);
	if (offset < 0 || offset >= visible) return undefined;
	const index = keepVisible(scrollTop, cursor, itemCount) + offset;
	return index < itemCount ? index : undefined;
}

type InputEdit = {
	readonly text: string;
	readonly cursor: number;
	readonly submit: boolean;
	readonly pasting: boolean;
	readonly handled: boolean;
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * 把终端读到的一段字符并进输入框。
 *
 * 支持光标移动、行内 Home/End、删除、bracketed paste 多行粘贴；历史上下键由调用方处理。
 * 转义序列通常在一次读取里完整到达，未识别的序列整段丢弃，不能当成文字填进去。
 */
function editInput(
	current: string,
	currentCursor: number,
	chunk: string,
	pasting: boolean,
): InputEdit {
	let text = current;
	let cursor = Math.min(Math.max(0, currentCursor), current.length);
	let submit = false;
	let isPasting = pasting;
	let handled = false;

	const insert = (value: string): void => {
		if (value.length === 0) return;
		text = text.slice(0, cursor) + value + text.slice(cursor);
		cursor += value.length;
		handled = true;
	};
	const insertPaste = (value: string): void => {
		insert(value.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
	};

	const applyKey = (sequence: string): void => {
		if (sequence === "\x1b[D" || sequence === "\x1bOD") {
			cursor = previousIndex(text, cursor);
		} else if (sequence === "\x1b[C" || sequence === "\x1bOC") {
			cursor = nextIndex(text, cursor);
		} else if (
			sequence === "\x1b[H" ||
			sequence === "\x1bOH" ||
			sequence === "\x1b[1~" ||
			sequence === "\x1b[7~"
		) {
			cursor = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
		} else if (
			sequence === "\x1b[F" ||
			sequence === "\x1bOF" ||
			sequence === "\x1b[4~" ||
			sequence === "\x1b[8~"
		) {
			const end = text.indexOf("\n", cursor);
			cursor = end < 0 ? text.length : end;
		} else if (sequence === "\x1b[3~") {
			const end = nextIndex(text, cursor);
			if (end > cursor) text = text.slice(0, cursor) + text.slice(end);
			handled = true;
		} else {
			return;
		}
		handled = true;
	};

	const normal = (value: string): void => {
		for (let index = 0; index < value.length; index += 1) {
			const char = value[index] ?? "";
			if (char === "\x1b") {
				const rest = value.slice(index);
				const match = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
				if (match !== null) {
					applyKey(match[0]);
					index += match[0].length - 1;
				}
				continue;
			}
			if (char === "\r" || char === "\n") {
				submit = true;
				return;
			}
			if (char === "\x7f" || char === "\b") {
				if (cursor > 0) {
					const start = previousIndex(text, cursor);
					text = text.slice(0, start) + text.slice(cursor);
					cursor = start;
					handled = true;
				}
				continue;
			}
			if (char >= " ") {
				insert(char);
			}
		}
	};

	let index = 0;
	while (index < chunk.length && !submit) {
		if (isPasting) {
			const end = chunk.indexOf(PASTE_END, index);
			if (end < 0) {
				insertPaste(chunk.slice(index));
				index = chunk.length;
				break;
			}
			insertPaste(chunk.slice(index, end));
			isPasting = false;
			index = end + PASTE_END.length;
			continue;
		}

		const start = chunk.indexOf(PASTE_START, index);
		const stop = start < 0 ? chunk.length : start;
		normal(chunk.slice(index, stop));
		if (submit || start < 0) break;

		const end = chunk.indexOf(PASTE_END, start + PASTE_START.length);
		if (end < 0) {
			insertPaste(chunk.slice(start + PASTE_START.length));
			isPasting = true;
			index = chunk.length;
			break;
		}
		insertPaste(chunk.slice(start + PASTE_START.length, end));
		index = end + PASTE_END.length;
	}

	return { text, cursor, submit, pasting: isPasting, handled };
}

function previousIndex(text: string, index: number): number {
	if (index <= 0) return 0;
	const code = text.charCodeAt(index - 1);
	if (code >= 0xdc00 && code <= 0xdfff) {
		const high = text.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) return index - 2;
	}
	return index - 1;
}

function nextIndex(text: string, index: number): number {
	if (index >= text.length) return text.length;
	const code = text.charCodeAt(index);
	if (code >= 0xd800 && code <= 0xdbff) {
		const low = text.charCodeAt(index + 1);
		if (low >= 0xdc00 && low <= 0xdfff) return index + 2;
	}
	return index + 1;
}

/** 多行输入里上下移动光标；单行输入交给历史。 */
function moveInputVertical(text: string, cursor: number, delta: number): number | undefined {
	const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
	const column = cursor - lineStart;
	if (delta < 0) {
		if (lineStart === 0) return undefined;
		const previousEnd = lineStart - 1;
		const previousStart = text.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
		return previousStart + Math.min(column, previousEnd - previousStart);
	}
	const lineEnd = text.indexOf("\n", cursor);
	if (lineEnd < 0) return undefined;
	const nextStart = lineEnd + 1;
	const nextEnd = text.indexOf("\n", nextStart);
	const end = nextEnd < 0 ? text.length : nextEnd;
	return nextStart + Math.min(column, end - nextStart);
}
