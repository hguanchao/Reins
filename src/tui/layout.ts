import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { AgentEvent, AgentEventListener } from "../agent/events.ts";
import { inputView, queueHeight, renderFooter, type FooterInfo } from "./footer.ts";
import { APPROVAL_MODES, THINKING_LEVELS, type ApprovalMode, type NotifyMode, type ThinkingLevel } from "../config/config-file.ts";
import type { ApprovalBroker, ApprovalPrompt } from "../permission/approval.ts";
import type { ApprovalAnswer } from "../permission/policy.ts";
import { describeToolCall, displayToolName, sanitizeDetail } from "../tools/describe.ts";
import { formatDuration } from "../tools/format.ts";
import { renderMain } from "./main.ts";
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
	sessionMenuHeight,
	renderSessionMenu,
	type SessionMenuItem,
	type SessionMenuState,
} from "./session-menu.ts";
import {
	commandMenuHeight,
	renderCommandMenu,
	type CommandMenuItem,
	type CommandMenuState,
} from "./command-menu.ts";
import { keepVisible, MENU_MAX_VISIBLE } from "./menu-panel.ts";
import { helpPageLines, mcpsPageLines, renderPage, skillsPageLines, type PageEntry, type SkillPageEntry } from "./pages.ts";
import { scrollButtonHit, scrollButtonPlacement } from "./scroll-button.ts";
import { appendToolLine, attachToolFailure, attachToolResult, buildTranscriptView, collapseToolGroups, findToolByCallId, findTopLevelToolByCallId, measureTranscriptView, renderTranscriptView, scrollbarColumn, scrollTopForRow, thinkingHeaderInView, todoHeaderInView, toggleLastExpandable, toggleLastToolResult, toolGroupHeaderInView, toolHeaderInView, type TranscriptLine, type TranscriptMarkdown, type TranscriptThinking, type TranscriptTool, type TranscriptTurn, type TranscriptView } from "./transcript.ts";
import { todoCardFromArgs, type TodoAnimationFrame, type TranscriptTodo } from "./todo-card.ts";

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
/**
 * 按钮事件上报加 SGR 坐标。
 *
 * 1002 只上报按住键的拖动，1003 连指针的空移动也上报——悬停高亮靠的是后者。两个都开：不认
 * 1003 的终端退回只有拖动上报，点击与拖动照常可用，只是没有悬停。代价是鼠标每动一下都有
 * 数据进来，所以悬停只在状态真的变化时才重绘。
 */
const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l";
/** 粘贴多行内容时不把换行当成提交。 */
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
/**
 * DEC 2026 同步输出：整帧写完才一次性呈现。
 *
 * 每帧重绘整屏，如果终端边解析边刷新，滚动和转圈时就会看到半帧旧内容、半帧新内容。
 * 不支持的终端会忽略这两个序列，行为与现在一致。
 */
const BEGIN_SYNCHRONIZED_UPDATE = "\x1b[?2026h";
const END_SYNCHRONIZED_UPDATE = "\x1b[?2026l";
const RESET = "\x1b[0m";
/** 擦掉光标所在行；逐行覆盖前先擦，页脚这类不补满宽度的行才不会留下上一帧的尾巴。 */
const ERASE_LINE = "\x1b[K";
const ERASE_BELOW = "\x1b[J";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/** Ctrl+C 在原始模式下以控制字符到达，不会触发 SIGINT，必须自己识别。 */
const CTRL_C = "\x03";
/** 第一次 Ctrl+C 之后等待第二次的时间；超过就回到未确认状态。 */
const EXIT_CONFIRM_WINDOW_MS = 2000;
/** 运行时状态前的加载动画。 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 100;
/** 完整页脚除输入行外的固定行数:空白间隔、状态行、上下边框与常驻信息行。 */
const FULL_FOOTER_FIXED_LINES = 5;
/** 紧凑页脚除输入行外的固定行数:上下边框与常驻信息行。 */
const COMPACT_FOOTER_FIXED_LINES = 3;
/** 输入行首行相对页脚顶部的 1 基行号:完整页脚排在空行、状态行、上边框之后。 */
const FULL_FOOTER_INPUT_ROW = 4;
/** 紧凑页脚里输入行紧跟上边框。 */
const COMPACT_FOOTER_INPUT_ROW = 2;
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
const SESSION_UNAVAILABLE = "Session storage is unavailable";
/** 使用者按下中断之后的状态。主动停下不是错误，用中性措辞，不染错误色。 */
const ABORTING = "Stopping...";
const STOPPED = "Stopped";
/** 对话流里的中断标记：说明这一轮的回答在这里被截断了。 */
const INTERRUPTED = "Interrupted";
const ERROR_STATUS = "Error";

/**
 * 一轮进行中也能执行的命令。
 *
 * 它们只影响界面（帮助页、选择面板）或下一轮，不碰正在跑的那一轮：模型与思考等级在
 * startRun 时就已交给客户端，改的是下一轮。/compact 会另起一轮，插件命令由插件自己决定，
 * 都等这一轮结束。
 */
const TURN_SAFE_COMMANDS: ReadonlySet<string> = new Set(["help", "model", "effort"]);

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
	/** 当前正在流式写入的 Markdown 文本块；遇到工具、系统行或回合结束时关闭 */
	textBlock: TranscriptMarkdown | undefined;
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

/** 切换会话的结果：对话流要整体换掉，而不是在末尾追加。 */
export interface SessionSwitchResult {
	/** false 表示选中的就是当前会话，界面不需要重放历史 */
	readonly changed: boolean;
	readonly history: readonly TranscriptTurn[];
	readonly warnings: readonly string[];
}

export interface SessionMenuSource {
	/** 当前项目的全部会话，按最近活动从新到旧；每次打开菜单时重新取 */
	readonly list: () => readonly SessionMenuItem[];
	/** 切换会话；失败时抛错，由界面显示原因 */
	readonly select: (id: string) => SessionSwitchResult;
}

export interface EffortMenuSource {
	/** 当前配置里的思考等级；切换后重新读取 */
	readonly current: () => ThinkingLevel;
	/** 确认选择；失败时抛错，由界面显示原因 */
	readonly select: (level: ThinkingLevel) => void;
}

/**
 * 审批模式的数据来源。
 *
 * 只提供「读当前档位」和「落到下一档」两件事，循环顺序与按键都由界面决定：宿主只管策略，
 * 界面管交互，二者各自单一职责。切换只在本次运行内有效，不回写配置。
 */
export interface ApprovalModeSource {
	/** 当前审批方式；徽标逐帧读取，不拍快照 */
	readonly current: () => ApprovalMode;
	/** 切到指定档位；失败时抛错，由界面显示原因 */
	readonly select: (mode: ApprovalMode) => void;
}

/** 插件与宿主注册的斜杠命令；由装配处桥接到 PluginHost。 */
export interface PluginCommandSource {
	/** 当前可用的命令；每次重算补全时重新取，不在界面创建时拍成快照 */
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

/** 整屏页的三种内容；三者共用同一套排版与滚动。 */
type PageKind = "help" | "skills" | "mcps";

/**
 * `/skills` 页的内容。
 *
 * 清单按需读取：每次打开页面都重扫一遍，改完 SKILL.md 重新打开就能看到。提示词那一份也是
 * 每轮重读的，两者取的是同一个来源，不会一个看得到、另一个看不到。
 */
export interface SkillsPageSource {
	readonly list: () => readonly SkillPageEntry[];
	/** 实际扫过的目录，脚注逐条列出 */
	readonly directories: readonly string[];
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
	/** 审批模式的数据来源；不提供时 Shift+Tab 无效、页脚也不显示徽标 */
	readonly approvalMode?: ApprovalModeSource;
	/** /model 菜单的数据来源；不提供时 /model 按普通输入处理 */
	readonly modelMenu?: ModelMenuSource;
	/** /effort 菜单的数据来源；不提供时 /effort 不可用 */
	readonly effortMenu?: EffortMenuSource;
	/** 插件与宿主注册的斜杠命令；不提供时只有内置命令 */
	readonly pluginCommands?: PluginCommandSource;
	/** /skills 的数据来源；不提供时该命令不可用 */
	readonly skills?: SkillsPageSource;
	/** /mcps 的数据来源；不提供时该命令不可用（MCP 插件缺席就是这种情况） */
	readonly mcpServers?: () => readonly PageEntry[];
	/** /session 菜单的数据来源；不提供时该命令不可用（没有会话存储时就是这种情况） */
	readonly sessionMenu?: SessionMenuSource;
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
 * 重试原因压成一行短提示。
 *
 * 状态行只有一行：控制字符会弄乱排版，过长的原因（端点常把整段错误体塞进消息里）会把
 * 计时与用量挤掉。
 */
function shortReason(reason: string): string {
	const first = reason.split("\n", 1)[0] ?? "";
	const clean = first.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
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
			name: "session",
			description:
				options.sessionMenu === undefined
					? "Session storage is unavailable"
					: "Switch to another session in this project",
			enabled: options.sessionMenu !== undefined,
		},
		{
			name: "help",
			description: "Show the commands and keys",
			enabled: true,
		},
		{
			name: "skills",
			description:
				options.skills === undefined
					? "Unavailable in this session"
					: "List the skills found on disk",
			enabled: options.skills !== undefined,
		},
		{
			name: "mcps",
			description:
				options.mcpServers === undefined
					? "No MCP plugin in this session"
					: "List MCP server connections and their tools",
			enabled: options.mcpServers !== undefined,
		},
	];

	/** 内置命令 + 当前插件命令；同名时内置优先，插件不能顶掉 /model 这类入口。 */
	const commands = (): readonly CommandMenuItem[] => {
		const plugin = options.pluginCommands?.list() ?? [];
		const names = new Set(builtinCommands.map((command) => command.name));
		return [...builtinCommands, ...plugin.filter((command) => !names.has(command.name))];
	};

	/** 打开一整页：滚动位置回到顶部，下次绘制按当前宽度重排。 */
	const showPage = (kind: PageKind): void => {
		openPage = kind;
		pageScrollTop = 0;
		pageCache = undefined;
	};

	/** 页面内容；宽度变了才重排，滚动与重绘都复用同一份。 */
	const pageLines = (kind: PageKind, width: number): readonly string[] => {
		if (pageCache?.kind === kind && pageCache.width === width) return pageCache.lines;
		const lines = buildPage(kind, width);
		pageCache = { kind, width, lines };
		return lines;
	};

	const buildPage = (kind: PageKind, width: number): readonly string[] => {
		if (kind === "help") return helpPageLines(width, commands());
		if (kind === "skills") {
			const source = options.skills;
			if (source === undefined) return skillsPageLines(width, [], []);
			return skillsPageLines(width, source.list(), source.directories);
		}
		return mcpsPageLines(width, options.mcpServers?.() ?? []);
	};

	let input = "";
	let inputCursor = 0;
	/**
	 * 排队中的消息，按发送顺序。
	 *
	 * 一轮进行中提交的内容放这里，本轮收尾后再逐条各发一轮。它们不进会话文件：排队消息还没
	 * 发生过，写进会话会让重放出现模型从未见过的用户消息。
	 */
	const queued: string[] = [];
	/**
	 * 下一次中止是否要把队首立刻发出去。
	 *
	 * 中止默认不续发队列，只有 Esc 这一个入口例外：使用者按它就是要「别等这一轮了，说下一条」。
	 * 用一次性标志而不是改中止规则，别的中止路径（Ctrl+C、退出）行为保持不变。
	 */
	let sendQueuedAfterAbort = false;
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
	/**
	 * 一轮进行中执行的命令，回复暂存在这里，等这一轮结束再落进对话流。
	 *
	 * 直接插进对话流不行：视图会跟着最后一条提示贴底，排在后面的块被持续输出顶走，排在前面的
	 * 块当场就被滚出视野。等这一轮收尾再追加，位置在末尾、时间顺序也对。
	 */
	const pendingCommandTurns: LiveTurn[] = [];
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
	/** 对话流构建缓存：同一内容只换行一次，测量、绘制与命中共用。 */
	let transcriptView: TranscriptView | undefined;
	let transcriptViewWidth = -1;
	let transcriptViewNotice: string | undefined;
	let transcriptDirty = true;
	/** 是否正按住滚动条拖动。 */
	let draggingScrollbar = false;
	/** 指针是否停在置底按钮上；只影响按钮颜色。 */
	let buttonHovered = false;
	/** 当前运行时状态；为空表示空闲。 */
	let statusText: string | undefined;
	/** 状态是不是失败结局；失败用错误色，别跟「正在进行」混成一样。 */
	let statusTone: "warning" | "error" | "stopped" | undefined;
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
	let sessionMenu: SessionMenuState | undefined;
	let commandMenu: CommandMenuState | undefined;
	/**
	 * 使用者用 Esc 主动关掉补全面板之后，输入没变就不再自动弹出。
	 *
	 * 否则每按一次键都会重新算一遍补全，面板刚关掉又冒出来，像关不掉一样；而且重开时光标
	 * 回到第一项，接着按回车会执行错的命令。
	 */
	let commandMenuDismissed = false;
	/** 占据主区域的整屏页；打开期间视口只跟着它自己的滚动。 */
	let openPage: PageKind | undefined;
	/** 整屏页从顶部滚过的行数。 */
	let pageScrollTop = 0;
	/** 排好版的页面内容；宽度不变就复用，滚动与重绘都不必重排。 */
	let pageCache:
		| { readonly kind: PageKind; readonly width: number; readonly lines: readonly string[] }
		| undefined;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
	let exitArmed = false;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let finish = (): void => {};
	const decoder = new StringDecoder("utf8");

	/**
	 * 页脚常驻信息。
	 *
	 * 审批徽标每帧从数据源现读，而不是跟着启动配置拍快照：Shift+Tab 切换之后下一帧
	 * 就得是新档位，否则显示与实际判定会脱节。
	 */
	const currentInfo = (): FooterInfo => {
		const info = typeof options.info === "function" ? options.info() : options.info;
		const mode = options.approvalMode?.current();
		return mode === undefined ? info : { ...info, approval: mode };
	};

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
					: sessionMenu !== undefined
						? sessionMenuHeight(sessionMenu.items.length)
						: commandMenu !== undefined
							? commandMenuHeight(commandMenu.items.length)
							: 0;
	const menuOpen = (): boolean =>
		approvalPrompt !== undefined ||
		modelMenu !== undefined ||
		effortMenu !== undefined ||
		sessionMenu !== undefined ||
		commandMenu !== undefined;
	/** 整屏页与菜单一样把输入框让给内容：紧凑页脚、不画光标。 */
	const compactFooter = (): boolean => menuOpen() || openPage !== undefined;
	const inputLineCount = (): number => {
		const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
		return inputView(input, width, inputCursor).lines.length;
	};
	const footerHeight = (): number => {
		if (approvalPrompt !== undefined) return APPROVAL_PANEL_HEIGHT;
		// 整屏页不保留输入框与常驻信息
		if (openPage !== undefined) return 0;
		const lines = inputLineCount();
		if (!compactFooter()) return FULL_FOOTER_FIXED_LINES + queueHeight(queued.length) + lines;
		return COMPACT_FOOTER_FIXED_LINES + lines + menuHeight();
	};

	/**
	 * 输入行首行在终端里的 1 基行号。
	 *
	 * 光标定位与点击命中必须用同一份几何,否则页脚结构调整时两者会各错各的。
	 */
	const inputTopRow = (mainHeight: number): number =>
		compactFooter()
			? mainHeight + menuHeight() + COMPACT_FOOTER_INPUT_ROW
			: mainHeight + FULL_FOOTER_INPUT_ROW + queueHeight(queued.length);

	const markTranscriptDirty = (): void => {
		transcriptDirty = true;
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
						// 转圈与扫光都表示「还在动」：失败与主动停下都不该带着它们
						symbol:
							statusTone === "error" || statusTone === "stopped"
								? ""
								: (SPINNER_FRAMES[spinnerFrame] ?? ""),
						text: statusText,
						sweep: statusTone === "error" || statusTone === "stopped" ? undefined : sweepPhase,
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
						: sessionMenu !== undefined
							? renderSessionMenu(width, sessionMenu)
							: commandMenu !== undefined
								? renderCommandMenu(width, commandMenu)
								: [];
		const inputLines = inputView(input, width, inputCursor);
		// 输入以已注册的命令开头时把命令本身着色，参数保持正文色
		const typedCommand = input.startsWith("/") ? (input.slice(1).split(/\s/, 1)[0] ?? "") : "";
		const commandLength = commands().some((item) => item.name === typedCommand)
			? typedCommand.length + 1
			: 0;
		const footer =
			openPage !== undefined || approvalPrompt !== undefined
				? []
				: compactFooter()
					? renderFooter(
							width,
							input,
							focused &&
								modelMenu === undefined &&
								effortMenu === undefined &&
								sessionMenu === undefined &&
								openPage === undefined,
							undefined,
							currentInfo(),
							{ leadingGap: false, showStatus: false, cursor: inputCursor, commandLength },
						)
					: renderFooter(width, input, focused, status, currentInfo(), {
							cursor: inputCursor,
							commandLength,
							queued,
						});
			const transcriptShown = openPage === undefined && (hasInput || activeWarning !== undefined);
			// 运行中任务卡按当前帧重建转圈与扫光；没有动画行时这只是原样返回缓存行
			const todoFrame: TodoAnimationFrame = { spinner: SPINNER_FRAMES[spinnerFrame] ?? "", sweepPhase };
			const main =
				openPage !== undefined
					? renderPage(pageLines(openPage, width), mainHeight, pageScrollTop)
					: transcriptShown
						? renderTranscriptView(view, mainHeight, scrollTop, todoFrame)
						: renderMain(width, mainHeight, options.version);
		const mainLines = [...main];
		// 整屏自上而下：主区域、面板、页脚；终端比内容矮时只保留前几行
		const lines = [...mainLines, ...menuLines, ...footer].slice(0, height);
		const inputRow = inputTopRow(mainHeight) + inputLines.row;
		// 选择面板只盖在输入框上方，输入行仍然可见可编辑，光标照常显示；
		// 只有整屏页与审批面板会夺走焦点
		const cursor =
			focused &&
			openPage === undefined &&
			approvalPrompt === undefined &&
			inputRow <= height
				? moveCursor(inputRow, inputLines.column) + SHOW_CURSOR
				: "";

		// 每一行按自己的坐标写，而不是靠换行符顺推。一行的实际列宽取决于终端怎么算其中的字符
		// （歧义宽度字符各终端算 1 列或 2 列），算得比我们宽时终端会替它换行，顺推下去后面的
		// 行就整体错位。按坐标写时溢出的尾巴会被下一行覆盖，只损失这一行末尾一两个字符。
		// 不再整屏清空：先擦行再覆盖，旧内容不会在清屏与重绘之间闪一下。
		let frame = HIDE_CURSOR + BEGIN_SYNCHRONIZED_UPDATE;
		for (let row = 0; row < lines.length; row += 1) {
			frame += `${moveCursor(row + 1, 1)}${RESET}${ERASE_LINE}${lines[row]}`;
		}
		// 滚动条列最后单独画：它只依赖自己的行列位置，内容怎么换行都不会把它带断
		if (transcriptShown) {
			// 用 scrollLines 而不是 totalLines：留白也是能滚到的范围，滑块大小与位置得按
			// 真实量程算，否则滑块几乎满格、怎么滚都不动
			const gutter = scrollbarColumn(mainHeight, metrics.scrollLines, scrollTop);
			for (let row = 0; row < gutter.length; row += 1) {
				frame += `${moveCursor(row + 1, width)}${gutter[row]}`;
			}
		}
		// 置底按钮同样单独定位：它盖在对话流最后一行中部，只在真的离开底部时出现
		const showButton = transcriptShown && !menuOpen() && scrollTop < maxScroll;
		// 按钮没画出来时悬停状态要一起清掉，否则下次出现会带着上一次的高亮
		if (!showButton) buttonHovered = false;
		if (showButton) {
			const button = scrollButtonPlacement(width, mainHeight, buttonHovered);
			if (button !== undefined) frame += `${moveCursor(button.row, button.column)}${button.text}`;
		}
		// 终端变高后，上一帧底部的行不在这一帧的覆盖范围内，补一次擦除
		if (lines.length < height) {
			frame += `${moveCursor(lines.length + 1, 1)}${RESET}${ERASE_BELOW}`;
		}
		stdout.write(frame + cursor + END_SYNCHRONIZED_UPDATE);
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

	/** 武装退出确认:2 秒内再按一次 Ctrl+C 才真正离开。三条路径共用同一份武装。 */
	const armExit = (): void => {
		exitArmed = true;
		exitTimer = setTimeout(disarm, EXIT_CONFIRM_WINDOW_MS);
	};

	const onCtrlC = (): void => {
		if (activeTurn !== undefined) {
			// 第一次只中止当前轮；2 秒内再按一次强制退出
			if (exitArmed) {
				cleanup();
				return;
			}
			armExit();
			options.approval?.denyAll();
			activeTurn.controller.abort();
			setStatus(ABORTING);
			render();
			return;
		}
		if (openPage !== undefined) {
			// 整屏页是模态视图：第一次按回对话流，连按两次才退出
			if (exitArmed) {
				cleanup();
				return;
			}
			openPage = undefined;
			armExit();
			render();
			return;
		}
		if (exitArmed) {
			cleanup();
			return;
		}
		armExit();
	};

	const setStatus = (text: string, tone?: "warning" | "error" | "stopped"): void => {
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

				const block = activeTurn.thinkingBlock;
				const startedAt = activeTurn.thinkingStartedAt;
				if (block !== undefined && startedAt !== undefined) {
					// 按整秒更新，避免每个 spinner tick 都重建整份对话流
					const header = `Thinking… ${formatDuration(Math.floor((now - startedAt) / 1000) * 1000)}`;
					if (block.header !== header) {
						block.header = header;
						markTranscriptDirty();
					}
				}
			}
			render();
		}, SPINNER_INTERVAL_MS);
	};

	const syncTurn = (active: ActiveTurn): void => {
		const response = active.turn.response;
		// 只追加新行；整份数组复制会让每个 token 都随历史长度线性变慢
		for (let index = response.length; index < active.lines.length; index += 1) {
			response.push(active.lines[index]!);
		}
		markTranscriptDirty();
	};

	/** 工具行被换成组对象时，另一份数组里的引用也要整体替换。 */
	const syncTurnFull = (active: ActiveTurn): void => {
		const response = active.turn.response;
		response.length = 0;
		response.push(...active.lines);
		markTranscriptDirty();
	};

	const closeText = (active: ActiveTurn): void => {
		active.textBlock = undefined;
	};

	const appendAssistantText = (active: ActiveTurn, delta: string): void => {
		let block = active.textBlock;
		if (block === undefined) {
			block = { kind: "markdown", text: "" };
			active.textBlock = block;
			active.lines.push(block);
		}
		block.text += delta;
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
		closeText(active);
		active.lines.push(line);
		syncTurn(active);
	};

	/** 最近一张任务卡片：先看本轮，再往前找历史回合，用于进行中任务计时的继承。 */
	const lastTodoCard = (active: ActiveTurn): TranscriptTodo | undefined => {
		for (let index = active.lines.length - 1; index >= 0; index -= 1) {
			const line = active.lines[index];
			if (typeof line === "object" && line !== null && line.kind === "todo") return line;
		}
		for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
			const response = turns[turnIndex]?.response ?? [];
			for (let index = response.length - 1; index >= 0; index -= 1) {
				const line = response[index];
				if (typeof line === "object" && line !== null && line.kind === "todo") return line;
			}
		}
		return undefined;
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
			block.header = `Thought for ${formatDuration(Date.now() - startedAt)}`;
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
				// 思考开始：插入区块；正文实时写入，运行时默认只显示最后五行。
				// 不关闭当前文本块：同一条 assistant 消息的文本继续写回原来的块，思考块单独插在
				// 它后面。这样迟到的思考片段不会把一句话切成两段。
				if (active.thinkingBlock === undefined && event.text.trim().length === 0) {
					// 纯空白的思考没有可显示内容，不建一个只有标题的空块
					setStatus(THINKING);
					break;
				}
				if (active.thinkingBlock === undefined) {
					active.thinkingStartedAt = Date.now();
					const block: TranscriptThinking = {
						kind: "thinkingBlock",
						header: `Thinking… ${formatDuration(0)}`,
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
				// 任务卡片直接按参数渲染：模型发来的列表就是界面要显示的内容。解析不了的
				// 形状落回普通工具行，后面校验阶段的错误信息才有行可挂
				if (event.name === "todo") {
					const card = todoCardFromArgs(event.args);
					if (card !== undefined) {
						card.running = true;
						const current = card.items.find((item) => item.status === "in_progress");
						if (current !== undefined) {
							// 计时起点：同一任务在上一张卡片里也进行时继承，否则从现在起算
							const previousCard = lastTodoCard(active);
							const previous = previousCard?.items.find((item) => item.status === "in_progress");
							card.taskStartedAt =
								previousCard?.taskStartedAt !== undefined &&
								previous?.content === current.content
									? previousCard.taskStartedAt
									: Date.now();
						}
						appendLine(active, card);
						break;
					}
				}
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
				closeText(active);
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
					const tool = findTopLevelToolByCallId(active.lines, event.callId);
					if (tool !== undefined) {
						// 失败行就是调用行本身：保留命令与耗时，错误详情留给双击展开
						attachToolFailure(tool, sanitizeDetail(event.content ?? event.summary), event.durationMs);
						markTranscriptDirty();
					} else {
						appendLine(active, {
							kind: "tool",
							name: displayToolName(event.name),
							detail: event.summary,
							isError: true,
							durationMs: event.durationMs,
						});
					}
				} else {
					const tool = findToolByCallId(active.lines, event.callId);
					if (tool !== undefined) {
						attachToolResult(tool, event.name, event.content ?? event.summary, event.durationMs, event.details);
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
			case "notice":
				// 与这一轮无关的提示走状态行：它不该占对话流的位置，看一眼就够了
				setStatus(event.message);
				render();
				break;
			case "usage_recorded":
				// 压缩请求花掉的 token 属于压缩成本，不算这一轮对话的用量
				if (event.kind === "turn") active.tokensUsed += event.tokens;
				statusTokens = active.tokensUsed;
				// 每次请求的用量都反映到页脚上，不必等整轮跑完
				options.agent?.refreshInfo();
				break;
			case "retrying": {
				// 原因排在前面：限流、5xx 与连接断掉的样子完全不同，先说清是哪一种
				const retry = `Retrying (${event.attempt}/${event.maxAttempts})...`;
				const reason = shortReason(event.reason);
				setStatus(reason.length === 0 ? retry : `${reason} · ${retry}`, "warning");
				break;
			}
			case "error":
				closeThinking(active);
				appendLine(active, { text: `Error: ${event.message}`, kind: "error" });
				active.outcome = "error";
				setStatus(ERROR_STATUS, "error");
				break;
			case "aborted":
				closeThinking(active);
				// 使用者主动停下不是错误：用中性说明，不染错误色，也不加错误标记
				appendLine(active, { text: INTERRUPTED, kind: "info" });
				active.outcome = "aborted";
				setStatus(STOPPED, "stopped");
				break;
			case "turn_end":
				// 只思考、没产出正文也没调工具的一次请求，摘要行也要落下
				closeThinking(active);
				closeText(active);
				break;
			case "run_end":
				closeText(active);
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
			markTranscriptDirty();
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

	/**
	 * 把一条命令的回复放进对话流。
	 *
	 * 一轮进行中时先排队，等这一轮结束再追加：对话流会跟着最后一条提示贴底，插在流中间
	 * 无论排前还是排后都会被顶走。页脚已经即时反映了新模型，这里是留给回看的记录。
	 */
	const appendCommandTurn = (prompt: string, response: readonly TranscriptLine[]): void => {
		const block: LiveTurn = { prompt, response: [...response] };
		markTranscriptDirty();
		hasInput = true;
		if (activeTurn !== undefined) {
			pendingCommandTurns.push(block);
			return;
		}
		turns.push(block);
		render();
	};

	/** 写回模型选择；菜单回车确认与 `/model <provider>/<model>` 共用同一条路径。 */
	const selectModel = (item: ModelMenuItem): void => {
		const source = options.modelMenu;
		if (source === undefined) return;

		let response: TranscriptLine[];
		try {
			const result = source.select(item);
			ready = result.ready;
			activeWarning = result.warning;
			response = [
				`Model switched to ${item.provider}/${item.model}${activeTurn === undefined ? "." : " (from the next turn)."}`,
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
		appendCommandTurn("/model", response);
	};

	const confirmMenu = (): void => {
		if (modelMenu === undefined) return;

		const item = modelMenu.items[modelMenu.cursor];
		modelMenu = undefined;
		effortMenu = undefined;
		commandMenu = undefined;
		setInput("");

		if (item !== undefined) selectModel(item);
		render();
	};

	/** Tab 在最后一级面板只把选中项补进输入框，不执行；要切换仍按回车。 */
	const completeModelMenu = (): void => {
		const item = modelMenu?.items[modelMenu.cursor];
		if (item === undefined) return;

		modelMenu = undefined;
		effortMenu = undefined;
		commandMenu = undefined;
		setInput(`/model ${item.provider}/${item.model}`);
		// 补进输入框之后使用者要按回车确认，焦点必须在输入框上，否则那一下只会被当成抢焦点
		focused = true;
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

	/** 写回思考等级；菜单回车确认与 `/effort <level>` 共用同一条路径。 */
	const selectEffort = (level: ThinkingLevel): void => {
		const source = options.effortMenu;
		if (source === undefined) return;

		let response: TranscriptLine[];
		try {
			source.select(level);
			response = [
				`Effort set to ${level}${activeTurn === undefined ? "." : " (from the next turn)."}`,
			];
		} catch (error) {
			response = [
				{
					kind: "error",
					text: `Error: Failed to set effort: ${error instanceof Error ? error.message : String(error)}`,
				},
			];
		}
		appendCommandTurn("/effort", response);
	};

	const confirmEffortMenu = (): void => {
		if (effortMenu === undefined) return;

		const level = THINKING_LEVELS[effortMenu.cursor];
		effortMenu = undefined;
		setInput("");

		if (level !== undefined) selectEffort(level);
		render();
	};

	/** Tab 在最后一级面板只把选中项补进输入框，不执行；要写回仍按回车。 */
	const completeEffortMenu = (): void => {
		const level = effortMenu === undefined ? undefined : THINKING_LEVELS[effortMenu.cursor];
		if (level === undefined) return;

		effortMenu = undefined;
		setInput(`/effort ${level}`);
		focused = true;
		render();
	};

	const cancelEffortMenu = (): void => {
		effortMenu = undefined;
		modelMenu = undefined;
		setInput("");
		render();
	};

	const keepSessionCursor = (): void => {
		if (sessionMenu === undefined) return;
		sessionMenu.scrollTop = keepVisible(
			sessionMenu.scrollTop,
			sessionMenu.cursor,
			sessionMenu.items.length,
		);
	};

	const openSessionMenu = (): void => {
		const source = options.sessionMenu;
		if (source === undefined) return;

		commandMenu = undefined;
		modelMenu = undefined;
		effortMenu = undefined;
		let items: readonly SessionMenuItem[];
		try {
			items = source.list();
		} catch (error) {
			setInput("");
			follow = true;
			const message = error instanceof Error ? error.message : String(error);
			appendCommandTurn("/session", [
				{ kind: "error", text: `Error: Failed to list sessions: ${message}` },
			]);
			return;
		}
		if (items.length === 0) {
			setInput("");
			follow = true;
			appendCommandTurn("/session", ["No sessions in this project yet."]);
			return;
		}

		const current = items.findIndex((item) => item.current);
		sessionMenu = { items, cursor: current >= 0 ? current : 0, scrollTop: 0 };
		keepSessionCursor();
		render();
	};

	const moveSessionMenu = (delta: number): void => {
		if (sessionMenu === undefined) return;
		sessionMenu.cursor = Math.min(
			sessionMenu.items.length - 1,
			Math.max(0, sessionMenu.cursor + delta),
		);
		keepSessionCursor();
		render();
	};

	/** 切换后整段对话流都要换掉；旧会话的写入器同时释放。 */
	const switchSession = (id: string): void => {
		const source = options.sessionMenu;
		if (source === undefined) return;

		let result: SessionSwitchResult;
		try {
			result = source.select(id);
		} catch (error) {
			follow = true;
			const message = error instanceof Error ? error.message : String(error);
			appendCommandTurn("/session", [
				{ kind: "error", text: `Error: Failed to switch session: ${message}` },
			]);
			return;
		}
		if (!result.changed) {
			render();
			return;
		}

		turns.length = 0;
		for (const turn of result.history) {
			turns.push({ prompt: turn.prompt, response: [...turn.response] });
		}
		markTranscriptDirty();
		initialScroll = false;
		scrollTop = 0;
		follow = true;
		hasInput = turns.length > 0;
		// 上一个会话留下的状态/错误不该跟着出现在新会话里
		clearStatus();
		// 排队消息是发给旧会话的，换会话后没有意义
		queued.length = 0;
		appendCommandTurn("/session", [`Switched to session ${id}.`, ...result.warnings]);
	};

	const confirmSessionMenu = (): void => {
		if (sessionMenu === undefined) return;

		const item = sessionMenu.items[sessionMenu.cursor];
		sessionMenu = undefined;
		commandMenu = undefined;
		modelMenu = undefined;
		effortMenu = undefined;
		setInput("");

		// 选中的就是当前会话：关掉面板即可，不必重放一遍历史
		if (item === undefined || item.current) {
			render();
			return;
		}
		switchSession(item.id);
	};

	/** Tab 在最后一级面板只补全，不切换；要切换仍按回车。 */
	const completeSessionMenu = (): void => {
		const item = sessionMenu?.items[sessionMenu.cursor];
		if (item === undefined) return;

		sessionMenu = undefined;
		commandMenu = undefined;
		modelMenu = undefined;
		effortMenu = undefined;
		setInput(`/session ${item.id}`);
		focused = true;
		render();
	};

	const cancelSessionMenu = (): void => {
		sessionMenu = undefined;
		setInput("");
		render();
	};

	/** 输入变化后重算命令补全列表；只匹配斜杠后不含空格的命令名。 */
	const updateCommandMenu = (): void => {
		if (modelMenu !== undefined || effortMenu !== undefined || sessionMenu !== undefined) return;
		// Esc 关掉之后不再自动弹出：输入一变会重置这个标记，那时才会重新计算
		if (commandMenuDismissed) {
			commandMenu = undefined;
			return;
		}

		// 敲完命令名再按空格：有二级选择面板的直接打开它，没有的就把补全面板收掉。
		// 这里只认「命令名 + 空格」本身，后面已经打了参数就不再插手
		if (input.startsWith("/") && input.endsWith(" ") && !input.slice(1, -1).includes(" ")) {
			const name = input.slice(1, -1).toLowerCase();
			const command = commands().find((item) => item.name === name);
			commandMenu = undefined;
			if (command !== undefined) {
				if (name === "model") openModelMenu();
				else if (name === "effort") openEffortMenu();
				else if (name === "session") openSessionMenu();
			}
			return;
		}

		if (input.startsWith("/") && !input.slice(1).includes(" ")) {
			const query = input.slice(1).toLowerCase();
			const items = commands().filter(
				(command) =>
					command.name.toLowerCase().startsWith(query) ||
					command.description.toLowerCase().includes(query),
			);
			if (items.length > 0) {
				// 输入完整命令名时，光标落到这条命令上：描述里含同一个词的其他命令
				// 也匹配得上，不这样做，敲完 /session 回车会先执行排在前面的 /model
				const exact = items.findIndex((item) => item.name === query);
				const previous = commandMenu?.items[commandMenu.cursor]?.name;
				const cursor =
					exact >= 0
						? exact
						: previous === undefined
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
			textBlock: undefined,
			thinkingStartedAt: undefined,
			thinkingBlock: undefined,
			tokensUsed: 0,
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
				closeText(active);
				// 任务卡片退场：转圈与扫光只在回合运行期间存在，之后的进行中行是静态半圆
				for (const line of active.lines) {
					if (typeof line === "object" && line !== null && line.kind === "todo") line.running = false;
				}
				// 命令塌缩会把多条独立行并成一条组行，行数组可能整体变短，只能全量同步
				collapseToolGroups(active.lines);
				syncTurnFull(active);
				activeTurn = undefined;
				stopSpinner();
				// 这一轮期间切过的模型/思考等级，现在落到对话流末尾
				if (pendingCommandTurns.length > 0) {
					turns.push(...pendingCommandTurns);
					pendingCommandTurns.length = 0;
					markTranscriptDirty();
				}
				options.approval?.denyAll();
				syncApprovalPrompt();
				if (finished) return;
				disarm();
				options.agent?.refreshInfo();
				statusElapsedMs = Date.now() - active.startedAt;
				statusTokens = active.tokensUsed;
				if (active.outcome === "done") {
					clearStatus();
				} else if (active.outcome === "aborted") {
					setStatus(STOPPED, "stopped");
					scheduleStatusClear();
				} else {
					setStatus(ERROR_STATUS, "error");
					scheduleStatusClear();
				}
				render();
				if (active.outcome !== "aborted") {
					notify(active.outcome === "done" ? "Turn complete" : "Turn failed");
				}
				// 排队消息接上：中止是使用者的明确意图，默认不替他续发；只有 Esc 请求过立即发送才例外
				const sendQueued = sendQueuedAfterAbort;
				sendQueuedAfterAbort = false;
				if ((active.outcome !== "aborted" || sendQueued) && queued.length > 0) drainQueue();
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
				markTranscriptDirty();
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
				markTranscriptDirty();
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
			const source = options.modelMenu;
			if (source === undefined) {
				setInput("");
				statusElapsedMs = 0;
				statusTokens = 0;
				setStatus(CONFIGURATION_REQUIRED);
				render();
				return;
			}

			const target = args.trim();
			if (target.length === 0) {
				openModelMenu();
				return;
			}

			const items = source.list();
			const item = items.find((candidate) => `${candidate.provider}/${candidate.model}` === target);
			if (item === undefined) {
				appendCommandTurn("/model", [
					items.length === 0
						? "No models are available."
						: {
								kind: "error",
								text: `Error: Unknown model: ${target}. Run /model to choose from the list.`,
							},
				]);
				return;
			}
			setInput("");
			selectModel(item);
			return;
		}

		if (command.name === "effort") {
			const source = options.effortMenu;
			if (source === undefined) {
				setInput("");
				statusElapsedMs = 0;
				statusTokens = 0;
				setStatus(CONFIGURATION_REQUIRED);
				render();
				return;
			}

			const target = args.trim();
			if (target.length === 0) {
				openEffortMenu();
				return;
			}

			const level = THINKING_LEVELS.find((candidate) => candidate === target);
			if (level === undefined) {
				appendCommandTurn("/effort", [
					{
						kind: "error",
						text: `Error: Unknown effort: ${target}. Available: ${THINKING_LEVELS.join(", ")}.`,
					},
				]);
				return;
			}
			setInput("");
			selectEffort(level);
			return;
		}

		if (command.name === "session") {
			const source = options.sessionMenu;
			if (source === undefined) {
				setInput("");
				statusElapsedMs = 0;
				statusTokens = 0;
				setStatus(SESSION_UNAVAILABLE);
				render();
				return;
			}

			const target = args.trim();
			if (target.length === 0) {
				openSessionMenu();
				return;
			}
			setInput("");
			switchSession(target);
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

		if (command.name === "help" || command.name === "skills" || command.name === "mcps") {
			// 命令名不留在输入框里：整屏页期间输入框不接受按键
			setInput("");
			showPage(command.name);
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

	/**
	 * 把一条普通提问交给真实对话。
	 *
	 * 提交与出队都走这里：排队消息出队后与使用者当场提交是同一件事，差别只在谁触发的。
	 */
	const launch = (prompt: string): void => {
		const agent = options.agent;
		if (agent === undefined) {
			commandMenu = undefined;
			statusElapsedMs = 0;
			statusTokens = 0;
			setStatus(AGENT_UNAVAILABLE);
			render();
			return;
		}
		startRun(prompt, (onEvent, signal) => agent.runTurn(prompt, onEvent, signal));
	};

	/**
	 * 一轮结束后取队首再发一轮。
	 *
	 * 只有正常收尾才续发：被中止说明使用者要停下来，队列留着等他决定，不能替他继续。
	 */
	const drainQueue = (): void => {
		const next = queued.shift();
		if (next === undefined) return;
		launch(next);
	};

	/** 回车发送：把输入交给真实 TurnDriver，事件驱动对话流与状态行。 */
	const submit = (): boolean => {
		if (input.length === 0) {
			// 输入框空着而队列里还有东西：回车把队首发出去，中止之后靠它恢复队列
			if (activeTurn !== undefined || queued.length === 0) return false;
			drainQueue();
			return true;
		}

		const message = input.trim();
		if (message.length === 0) return false;
		const selected = commandMenu?.items[commandMenu.cursor];
		// 只有一个斜杠、又没有选中项：还不算命令，也不该当成提问发给模型
		if (message === "/" && selected === undefined) return false;
		const command = selected ?? findCommand(message);
		if (message.startsWith("/") && command !== undefined) {
			// 一轮进行中只放行不碰对话的命令；其余要等这一轮结束，但得说清为什么没执行。
			// 补全面板此刻占着状态行的位置，先收起它，提示才看得见
			if (activeTurn !== undefined && !TURN_SAFE_COMMANDS.has(command.name)) {
				commandMenu = undefined;
				commandMenuDismissed = true;
				setStatus(`/${command.name} is unavailable while a turn is running`);
				render();
				return false;
			}
			// 命令先于受限检查执行：/model 正是用来修复配置对不上的入口
			rememberInput(message);
			executeCommand(command, selected === undefined ? commandArgs(message, command.name) : "");
			return true;
		}

		rememberInput(message);
		// 一轮进行中不再丢输入：排进队列，本轮收尾后自动发送
		if (activeTurn !== undefined) {
			commandMenu = undefined;
			setInput("");
			queued.push(message);
			render();
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

		setInput("");
		launch(message);
		return true;
	};

	const onData = (chunk: Buffer): void => {
		const text = decoder.write(chunk);
		// 鼠标事件最多解析一次:同一条数据块会被多个面板分支检查,每次都跑一遍
		// matchAll 是纯浪费;纯键盘块则一次也不解析
		let mouseOfChunk: readonly MouseInput[] | undefined;
		const mouseOf = (): readonly MouseInput[] => {
			mouseOfChunk ??= mouseEvents(text);
			return mouseOfChunk;
		};
		// Ctrl+C 只认真实的按键块:粘贴的内容被括在粘贴标记里,其中的 \x03 是正文,
		// 不能当成中断或退出
		if (text.includes(CTRL_C) && !pasting && !text.includes(PASTE_START)) {
			onCtrlC();
			return;
		}

		if (shiftTabKey(text) && options.approvalMode !== undefined) {
			// 全局热键：任何面板下都先于其它分支处理，循环 ask → auto → yolo
			const source = options.approvalMode;
			const index = APPROVAL_MODES.indexOf(source.current());
			const next = APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] ?? "ask";
			try {
				source.select(next);
			} catch (error) {
				setStatus(
					`Failed to switch approval: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				scheduleStatusClear();
			}
			render();
			return;
		}

		if (approvalPrompt !== undefined) {
			// 审批是模态的：鼠标可点动作；键盘左右移动、回车确认，y/a/n 直接执行，Esc 拒绝
			const panelWidth = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
			const panelHeight = terminalHeight(stdout);
			const panelTop = Math.max(0, panelHeight - footerHeight());
			for (const event of mouseOf()) {
				const motion = dragMotion(event.button);
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

		if (modelMenu !== undefined || effortMenu !== undefined || sessionMenu !== undefined) {
			// 面板只接管选择相关的按键（上下、回车、Tab、Esc）与鼠标；其余按键放行给输入框。
			// 文字一变面板就收掉（见 editInput 处）：面板由命令打开，输入不再是那条命令
			// 面板上边框画在页脚区的第一行，页脚高 N 行时它就是 height-N+1（1 基）
			const panelTop = Math.max(1, terminalHeight(stdout) - footerHeight() + 1); 
			for (const event of mouseOf()) {
				const motion = dragMotion(event.button);
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
						// 点击即选中并确认：面板上点哪一项就用哪一项
						modelMenu.cursor = index;
						keepMenuCursor();
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
						// 点击即选中并确认：面板上点哪一档就用哪一档
						effortMenu.cursor = index;
						confirmEffortMenu();
						return;
					}
				} else if (sessionMenu !== undefined) {
					const index = menuIndexAtRow(
						event.row,
						panelTop,
						sessionMenu.items.length,
						sessionMenu.scrollTop,
						sessionMenu.cursor,
					);
					if (motion) {
						if (index !== undefined && index !== sessionMenu.cursor) {
							sessionMenu.cursor = index;
							keepSessionCursor();
							render();
							return;
						}
						continue;
					}
					if (event.press && event.button === 64) {
						moveSessionMenu(-1);
						return;
					}
					if (event.press && event.button === 65) {
						moveSessionMenu(1);
						return;
					}
					if (event.press && (event.button & 3) === 0 && index !== undefined) {
						// 点击即选中并确认：面板上点哪个会话就切到哪个会话
						sessionMenu.cursor = index;
						keepSessionCursor();
						confirmSessionMenu();
						return;
					}
				}
			}

			const key = menuKey(text);
			const inModel = modelMenu !== undefined;
			const inSession = sessionMenu !== undefined;
			if (key === "up" || key === "down") {
				if (inModel) moveMenu(key === "up" ? -1 : 1);
				else if (inSession) moveSessionMenu(key === "up" ? -1 : 1);
				else moveEffortMenu(key === "up" ? -1 : 1);
				return;
			}
			if (key === "enter") {
				if (inModel) confirmMenu();
				else if (inSession) confirmSessionMenu();
				else confirmEffortMenu();
				return;
			}
			if (key === "tab") {
				// 最后一级面板没有更深的选择：Tab 只补进输入框，不代替回车执行
				if (inModel) completeModelMenu();
				else if (inSession) completeSessionMenu();
				else completeEffortMenu();
				return;
			}
			if (key === "escape") {
				if (inModel) cancelMenu();
				else if (inSession) cancelSessionMenu();
				else cancelEffortMenu();
				return;
			}
			// 其余按键放行：打字的瞬间面板会随输入变化收掉（见下面的编辑处理）
		}

		if (openPage !== undefined) {
			// 整屏页是模态的：上下键与滚轮翻页，Esc 返回，其它按键忽略
			const rows = Math.max(0, terminalHeight(stdout) - footerHeight());
			const width = Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);
			const total = pageLines(openPage, width).length;
			let steps = 0;
			for (const event of mouseOf()) {
				if (event.press && event.button === 64) steps -= 1;
				else if (event.press && event.button === 65) steps += 1;
			}
			const key = menuKey(text);
			if (key === "up") steps -= 1;
			if (key === "down") steps += 1;
			const scroll = scrollKey(text);
			if (scroll === "pageUp") steps -= rows;
			if (scroll === "pageDown") steps += rows;

			if (key === "escape") {
				openPage = undefined;
				render();
				return;
			}
			if (scroll === "top") {
				pageScrollTop = 0;
				render();
				return;
			}
			if (steps !== 0) {
				pageScrollTop = Math.min(Math.max(0, pageScrollTop + steps), Math.max(0, total - rows));
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
		let hoverChanged = false;
		let wheelSteps = 0;
		let dragRow: number | undefined;
		/** 置底按钮；命中判定与悬停都用同一份位置，保证画在哪里就能点在哪里。 */
		const bottomButton = menuOpen() ? undefined : scrollButtonPlacement(width, mainHeight);
		/** 按钮此刻是否真的画着：没画出来的位置不该被点中，也不该响应悬停。 */
		const buttonShown = bottomButton !== undefined && scrollTop < maxScroll();

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

		for (const event of mouseOf()) {
			const left = (event.button & 3) === 0;
			const motion = event.button >= 32 && event.button < 64;
			// 低两位是 3 表示没有按键：1003 模式下这类事件只是指针在移动，也就是悬停
			const hover = motion && (event.button & 3) === 3;

			if (hover) {
				const over = buttonShown && scrollButtonHit(bottomButton, event.row, event.column);
				if (over !== buttonHovered) {
					buttonHovered = over;
					hoverChanged = true;
				}
				continue;
			}

			if (event.press && event.button === 64) {
				wheelSteps -= 1;
			} else if (event.press && event.button === 65) {
				wheelSteps += 1;
			} else if (event.press && left && !motion) {
				// 置底按钮盖在对话流上，命中就回到底部并恢复跟随，不再往下走双击与聚焦判断
				if (buttonShown && scrollButtonHit(bottomButton, event.row, event.column)) {
					scrollTop = maxScroll();
					follow = true;
					draggingScrollbar = false;
					lastClick = undefined;
					render();
					return;
				}

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
						// 一次双击把这一行藏着的东西打开。有 fullDetail 时展开的就是它本身
						// （文件类工具的结果、或被截短的命令），不再另铺一遍原始结果
						const open = tool.detailExpanded === true || tool.resultExpanded === true;
						tool.detailExpanded = !open;
						if (tool.fullDetail === undefined && tool.result !== undefined) {
							tool.resultExpanded = !open;
						}
						markTranscriptDirty();
						lastClick = undefined;
						follow = false;
						render();
						return;
					}

					const todo = todoHeaderInView(view, mainHeight, scrollTop, event.row);
					if (todo !== undefined) {
						todo.collapsed = todo.collapsed !== true;
						markTranscriptDirty();
						lastClick = undefined;
						follow = false;
						render();
						return;
					}
				}

				const inputLineTotal = inputView(input, width, inputCursor).lines.length;
				const inputTop = inputTopRow(mainHeight);
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
		}
		if (dragRow !== undefined) {
			const limit = maxScroll();
			scrollTop = scrollTopForRow(dragRow, mainHeight, limit);
			follow = scrollTop >= limit;
		}
		const scrollChanged = scrollTop !== beforeScroll;

		if (commandMenu !== undefined) {
			// 命令补全面板不拦截文字输入，只接管上下键、Esc 与鼠标
			const commandPanelTop = Math.max(1, terminalHeight(stdout) - footerHeight() + 1);
			for (const event of mouseOf()) {
				const motion = dragMotion(event.button);
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
					// 点击即选中并执行，与回车一致：有二级面板的命令点开面板，其余直接执行
					commandMenu.cursor = index;
					commandMenu.scrollTop = keepVisible(
						commandMenu.scrollTop,
						commandMenu.cursor,
						commandMenu.items.length,
					);
					const selected = commandMenu.items[commandMenu.cursor];
					if (selected === undefined) return;
					if (activeTurn !== undefined && !TURN_SAFE_COMMANDS.has(selected.name)) {
						commandMenu = undefined;
						commandMenuDismissed = true;
						setStatus(`/${selected.name} is unavailable while a turn is running`);
						render();
						return;
					}
					executeCommand(selected);
					return;
				}
			}

			const key = menuKey(text);
			if (key === "up" || key === "down") {
				moveCommandMenu(key === "up" ? -1 : 1);
				return;
			}
			if (key === "tab") {
				const selected = commandMenu.items[commandMenu.cursor];
				if (selected === undefined) return;
				// 有二级选择面板的命令，Tab 等同于回车：直接打开面板；一轮进行中只放行安全命令
				const opensPanel =
					(selected.name === "model" && options.modelMenu !== undefined) ||
					(selected.name === "effort" && options.effortMenu !== undefined) ||
					(selected.name === "session" && options.sessionMenu !== undefined);
				if (opensPanel && (activeTurn === undefined || TURN_SAFE_COMMANDS.has(selected.name))) {
					executeCommand(selected);
					return;
				}
				// 其余命令只补全命令名与一个空格，补全面板保持打开：Tab 不执行也不收起
				setInput(`/${selected.name} `);
				render();
				return;
			}
			if (key === "escape") {
				commandMenu = undefined;
				// 记下这次主动关闭：输入不变就不再自动弹回来
				commandMenuDismissed = true;
				render();
				return;
			}
		}

		// 输入框失焦后，回车只负责把焦点抢回来：这一下不提交，避免误发已经打好的内容。
		// 只认单独的换行块，粘贴进来的多行内容不会被当成聚焦键吞掉。
		if (!focused && (withoutMouse === "\r" || withoutMouse === "\n")) {
			focused = true;
			render();
			return;
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
			} else {
				scrollTop = 0;
				follow = false;
			}
			render();
			return;
		}

		// 排队消息的三个操作：Esc 中止并立即发队首，Alt+Up 撤回队尾，Alt+Down 丢弃队尾
		if (commandMenu === undefined) {
			if (withoutMouse === "\x1b" && activeTurn !== undefined && queued.length > 0) {
				// 中止默认不续发队列；这是唯一的例外——使用者明确要求立刻发出去
				sendQueuedAfterAbort = true;
				options.approval?.denyAll();
				activeTurn.controller.abort();
				setStatus(ABORTING);
				render();
				return;
			}

			const queueKey = queuedEditKey(withoutMouse);
			// 撤回与编辑是同一条路径：取回即出队，清掉文字就是取消
			if (queueKey === "recall") {
				const recalled = queued.pop();
				if (recalled !== undefined) {
					setInput(input.length === 0 ? recalled : `${recalled}\n${input}`);
					updateCommandMenu();
					render();
					return;
				}
			}
			// 丢弃不回填输入框：排错了的消息直接扔掉，不必先取回再删
			if (queueKey === "discard" && queued.pop() !== undefined) {
				render();
				return;
			}
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
		if (edit.text !== previous) {
			historyIndex = -1;
			// 输入变了，之前用 Esc 关掉补全面板的决定就作废：新内容该有自己的补全
			commandMenuDismissed = false;
		}
		// 文字一变，选择面板就收掉：面板由命令打开，输入一旦不再是那条命令它就失去意义；
		// 命令补全面板相反，跟着新输入继续过滤
		if (edit.text !== previous && (modelMenu !== undefined || effortMenu !== undefined || sessionMenu !== undefined)) {
			modelMenu = undefined;
			effortMenu = undefined;
			sessionMenu = undefined;
		}
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
		if (input !== previous || inputCursor !== previousCursor || edit.handled || focusChanged || hoverChanged || scrollChanged) {
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
	// 通知只是旁路提示,不能让事件循环为了它多等一拍
	child.unref();
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

/**
 * Shift+Tab 的转义序列。
 *
 * 终端有三种说法：`\x1b[Z`（xterm 一系，含 Windows Terminal）、带修饰键列的
 * `\x1b[1;2Z`、以及 kitty CSI-u 协议下的 `\x1b[9;2u`（9 是制表符码位，2 表示按下
 * Shift）。只认整段精确匹配：粘贴内容被括在成对的粘贴标记里，永远不会恰好等于一个
 * 裸序列；输入里零散的 `[Z` 之类文字也因此不会被当成切换。
 */
function shiftTabKey(text: string): boolean {
	return text === "\x1b[Z" || text === "\x1b[1;2Z" || text === "\x1b[9;2u";
}

/** 菜单打开时只认这四个键；普通字符与鼠标事件一律忽略。 */
function menuKey(text: string): "up" | "down" | "enter" | "tab" | "escape" | undefined {
	if (text.includes("\x1b[A") || text.includes("\x1bOA")) return "up";
	if (text.includes("\x1b[B") || text.includes("\x1bOB")) return "down";
	if (text.includes("\r") || text.includes("\n")) return "enter";
	// 只认单独的制表符：粘贴的内容里可能带 \t，不能把整块粘贴当成一次确认
	if (text === "\t") return "tab";
	if (text === "\x1b") return "escape";
	return undefined;
}

/** 输入历史只认完整的方向键序列，避免把粘贴内容里的序列当成翻历史。 */
function historyKey(text: string): -1 | 1 | undefined {
	if (text === "\x1b[A" || text === "\x1bOA") return -1;
	if (text === "\x1b[B" || text === "\x1bOB") return 1;
	return undefined;
}

/**
 * 撤回或丢弃排队消息的按键：Alt+Up 取回队尾，Alt+Down 直接丢弃。
 *
 * 只认单独到达的序列：方向键本身要给输入历史和光标用，必须靠修饰键把它们分开。
 */
function queuedEditKey(text: string): "recall" | "discard" | undefined {
	if (text === "\x1b[1;3A" || text === "\x1b[1;9A") return "recall";
	if (text === "\x1b[1;3B" || text === "\x1b[1;9B") return "discard";
	return undefined;
}

/** 对话流滚动键；不与输入行的 Home/End 抢按键。 */
function scrollKey(text: string): "pageUp" | "pageDown" | "top" | undefined {
	if (text === "\x1b[5~") return "pageUp";
	if (text === "\x1b[6~") return "pageDown";
	if (text === "\x1b[1;5H") return "top";
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

/**
 * 按住键拖动的移动事件。
 *
 * 1003 模式还会上报没按键的纯移动（低两位为 3），那只是指针在挪，不能当成拖动去改选中项。
 */
function dragMotion(button: number): boolean {
	return button >= 32 && button < 64 && (button & 3) !== 3;
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

/**
 * 菜单面板的屏幕行对应哪个条目。
 *
 * row 是终端上报的 1 基行号；panelTop 是面板上边框所在的 1 基行号。条目从上边框下一行
 * 开始，所以偏移量是 row - panelTop - 1。
 */
function menuIndexAtRow(
	row: number,
	panelTop: number,
	itemCount: number,
	scrollTop: number,
	cursor: number,
): number | undefined {
	const visible = Math.min(Math.max(0, itemCount), MENU_MAX_VISIBLE);
	if (visible === 0) return undefined;
	const offset = row - panelTop - 1;
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
