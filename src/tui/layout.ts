import { StringDecoder } from "node:string_decoder";
import { describeError } from "../describe-error.ts";

import type { AgentEvent, AgentEventListener } from "../agent/events.ts";
import { inputView, queueHeight, renderFooter, type FooterInfo } from "./footer.ts";
import { APPROVAL_MODES, THINKING_LEVELS, type ThinkingLevel } from "../config/config-file.ts";
import type { ApprovalPrompt } from "../permission/approval.ts";
import type { ApprovalAnswer } from "../permission/policy.ts";
import { describeToolCall, displayToolName, sanitizeDetail } from "../tools/describe.ts";
import { formatDuration } from "../tools/format.ts";
import { renderMain } from "./main.ts";
import { APPROVAL_PANEL_HEIGHT, approvalActionAt, renderApprovalPanel } from "./panel/approval-panel.ts";
import {
	modelMenuHeight,
	renderModelMenu,
	type ModelMenuItem,
	type ModelMenuState,
} from "./panel/model-menu.ts";
import {
	effortMenuHeight,
	renderEffortMenu,
	type EffortMenuState,
} from "./panel/effort-menu.ts";
import {
	sessionMenuHeight,
	renderSessionMenu,
	type SessionMenuItem,
	type SessionMenuState,
} from "./panel/session-menu.ts";
import type { CheckpointEntry, CheckpointPreview } from "../checkpoint/checkpoints.ts";
import {
	commandMenuHeight,
	renderCommandMenu,
	type CommandMenuItem,
	type CommandMenuState,
} from "./panel/command-menu.ts";
import { keepVisible } from "./panel/menu-panel.ts";
import {
	framedPage,
	helpPageLines,
	mcpsPageLines,
	renderPage,
	skillsPageLines,
} from "./pages.ts";
import {
	CHECKPOINT_ACTION_HEIGHT,
	checkpointListActions,
	checkpointListLines,
	checkpointPreviewActions,
	checkpointPreviewLines,
} from "./checkpoint-pages.ts";
import {
	JOB_ACTION_HEIGHT,
	jobListActions,
	jobListLines,
	jobOutputActions,
	jobOutputLines,
	jobElapsed,
	renderJobBarLine,
	type JobView,
} from "./job-pages.ts";
import { planActionLines, planReviewLines, PLAN_ACTION_HEIGHT } from "./plan-review.ts";
import { sandboxActionLines, sandboxPageLines, SANDBOX_ACTION_HEIGHT } from "./sandbox-page.ts";
import {
	attachmentSetError,
	imageLimitError,
	imageMarker,
	imagesInPrompt,
	isImagePath,
	uniqueImageName,
	type ImageAttachment,
	type PendingImage,
} from "./image-attachments.ts";
import {
	fileMenuHeight,
	filterFiles,
	findAtToken,
	formatFileReference,
	renderFileMenu,
	type FileMenuState,
} from "./panel/file-menu.ts";
import { THEME } from "./theme.ts";
import { scrollButtonHit, scrollButtonPlacement } from "./scroll-button.ts";
import type { AnimationFrame } from "./sweep.ts";
import { appendToolLine, attachToolFailure, attachToolResult, buildTranscriptView, collapseToolGroups, findToolByCallId, findTopLevelToolByCallId, hasRunningSubagent, isSubagentCall, measureTranscriptView, planHeaderInView, renderTranscriptView, scrollbarColumn, scrollTopForRow, thinkingHeaderInView, todoHeaderInView, subagentGroupHeaderInView, subagentFailureRowInView, toggleLastExpandable, toggleLastToolResult, toolGroupHeaderInView, toolHeaderInView, type TranscriptLine, type TranscriptMarkdown, type TranscriptPlan, type TranscriptThinking, type TranscriptTool, type TranscriptTurn, type TranscriptView } from "./transcript.ts";
import { todoCardFinished, todoCardFromArgs, todoPanelLines, TODO_PANEL_MAX_ITEMS, type TranscriptTodo } from "./todo-card.ts";
import {
	commandArgs,
	commandNameOf,
	createBuiltinCommands,
	findCommand,
	mergeCommands,
	TURN_SAFE_COMMANDS,
} from "./commands.ts";
import {
	approvalKey,
	dragMotion,
	editInput,
	historyKey,
	menuIndexAtRow,
	menuKey,
	mouseEvents,
	moveInputVertical,
	MOUSE_BUTTON_MASK,
	MOUSE_WHEEL_DOWN,
	MOUSE_WHEEL_UP,
	PASTE_END,
	PASTE_START,
	queuedEditKey,
	scrollKey,
	shiftTabKey,
	stripMouseEvents,
	type MenuMouseTarget,
	type MouseInput,
} from "./input.ts";
import type { PageKind, SessionSwitchResult, TuiInput, TuiOptions, TuiOutput } from "./options.ts";
import {
	ABORTING,
	AGENT_UNAVAILABLE,
	COMPACTING_CONTEXT,
	CONFIGURATION_REQUIRED,
	ERROR_STATUS,
	INTERRUPTED,
	RUNNING_TOOL,
	SESSION_UNAVAILABLE,
	THINKING,
	WAITING_FOR_MODEL,
	WAITING_FOR_SUBAGENT,
	WRITING_RESPONSE,
	WRITING_TOOL_CALL,
	errorLine,
	implementationPrompt,
	shortReason,
} from "./status.ts";
import {
	BEGIN_SYNCHRONIZED_UPDATE,
	CTRL_C,
	CURSOR_BLINKING_BAR,
	CURSOR_DEFAULT,
	DEFAULT_COLUMNS,
	DISABLE_BRACKETED_PASTE,
	DISABLE_FOCUS_REPORTING,
	DISABLE_MOUSE,
	ENABLE_BRACKETED_PASTE,
	ENABLE_FOCUS_REPORTING,
	ENABLE_MOUSE,
	END_SYNCHRONIZED_UPDATE,
	ENTER_ALTERNATE_SCREEN,
	ERASE_BELOW,
	ERASE_LINE,
	FOCUS_IN,
	FOCUS_OUT,
	HIDE_CURSOR,
	LEAVE_ALTERNATE_SCREEN,
	RESET,
	SHOW_CURSOR,
	desktopNotify,
	moveCursor,
	terminalHeight,
} from "./terminal.ts";

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

/** 一轮结束后状态行停留的时间。 */
const STATUS_CLEAR_MS = 1500;

/** 对话流里的一条真实回合；response 可变，流式文本和工具行持续追加。 */
interface LiveTurn extends TranscriptTurn {
	response: TranscriptLine[];
}

/** 排队的一条消息：文字与图片一起排队，出队时仍是一次完整输入。 */
interface QueuedPrompt {
	readonly text: string;
	readonly images: readonly ImageAttachment[];
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
	/** 平台限制的启动说明不属于可修复的配置问题，模型切换后仍然保留。 */
	const sandboxNotice = options.sandbox?.warning;
	const noticeText = (): string | undefined => {
		if (sandboxNotice === undefined || sandboxNotice.length === 0) return activeWarning;
		if (activeWarning === undefined || activeWarning.length === 0) return sandboxNotice;
		return `${sandboxNotice}\n\n${activeWarning}`;
	};
	// 命令补全列表：配置不可用时仍然显示，但标成不可执行
	const builtinCommands = createBuiltinCommands(options);

	/** 内置命令 + 当前插件命令；同名时内置优先，插件不能顶掉 /model 这类入口。 */
	const commands = (): readonly CommandMenuItem[] =>
		mergeCommands(builtinCommands, options.pluginCommands?.list() ?? []);

	/** 打开一整页：滚动位置回到顶部，下次绘制按当前宽度重排。 */
	const showPage = (kind: PageKind): void => {
		openPage = kind;
		pageScrollTop = 0;
		pageCache = undefined;
	};

	/** 页面内容；宽度变了才重排，滚动与重绘都复用同一份。 */
	const pageLines = (kind: PageKind, width: number): readonly string[] => {
		// 检查点与作业都有光标/实时状态：不缓存，避免画出上一帧
		if (
			kind === "checkpoints" ||
			kind === "checkpoint" ||
			kind === "jobs" ||
			kind === "job"
		) {
			return buildPage(kind, width);
		}
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
		if (kind === "sandbox") {
			const source = options.sandbox;
			return source === undefined ? [] : sandboxPageLines(source.info, width);
		}
		if (kind === "plan") {
			return planReview === undefined ? [] : planReviewLines(planReview, width);
		}
		if (kind === "checkpoints") {
			return checkpointListLines(checkpointList, width, checkpointCursor, checkpointLoading);
		}
		if (kind === "checkpoint") {
			return checkpointPreview === undefined
				? checkpointListLines([], width, 0)
				: checkpointPreviewLines(checkpointPreview, width);
		}
		if (kind === "jobs") {
			const jobs = options.jobs?.list() ?? [];
			jobCursor = Math.min(jobCursor, Math.max(0, jobs.length - 1));
			return jobListLines(jobs, width, jobCursor);
		}
		if (kind === "job") {
			const job = options.jobs?.list().find((candidate) => candidate.id === jobDetailId);
			if (job === undefined) {
				return [
					`${THEME.accent}Reins — jobs${RESET}`,
					"",
					`${THEME.textSubtle}  This job is no longer available.${RESET}`,
				];
			}
			return jobOutputLines(job, options.jobs?.output(job.id) ?? "", width);
		}
		return mcpsPageLines(width, options.mcpServers?.() ?? []);
	};

	/** 打开计划审批页；计划同时成为 /view-plan 的最近一份。 */
	const openPlanReview = (plan: TranscriptPlan): void => {
		planReview = plan;
		latestPlan = plan;
		// 审批页是整屏模态：自动打开时先收掉可能在回合期间留下的菜单
		commandMenu = undefined;
		modelMenu = undefined;
		effortMenu = undefined;
		sessionMenu = undefined;
		showPage("plan");
	};

	/** 关闭审批页但保留最近一份计划，之后仍可用 /view-plan 打开。 */
	const closePlanReview = (): void => {
		if (openPage === "plan") openPage = undefined;
		planReview = undefined;
		pageScrollTop = 0;
	};

	/** 计划页的可见内容：正文按可用高度滚动，动作条永远停在底部。 */
	const planPageLines = (width: number, height: number): readonly string[] =>
		framedPage(pageLines("plan", width), planActionLines(width), height, pageScrollTop);

	/** 检查点列表/确认页：正文可滚动，动作条固定在底部。 */
	const checkpointPageLines = (width: number, height: number): readonly string[] => {
		const actions =
			openPage === "checkpoints"
				? checkpointListActions(width)
				: checkpointPreviewActions(width, checkpointPreview?.entry.kind ?? "turn");
		return framedPage(pageLines(openPage ?? "checkpoints", width), actions, height, pageScrollTop);
	};

	/** 后台作业列表/输出页：与检查点页相同的固定动作条。 */
	const jobPageLines = (width: number, height: number): readonly string[] => {
		const selected = options.jobs?.list().find((job) => job.id === jobDetailId);
		const actions =
			openPage === "jobs"
				? jobListActions(width)
				: jobOutputActions(width, selected?.status ?? "done");
		return framedPage(pageLines(openPage ?? "jobs", width), actions, height, pageScrollTop);
	};

	/** 沙箱说明页：内容只读，动作条固定为关闭提示。 */
	const sandboxPageFrame = (width: number, height: number): readonly string[] =>
		framedPage(pageLines("sandbox", width), sandboxActionLines(width), height, pageScrollTop);

	let input = "";
	let inputCursor = 0;
	/** 当前输入里的图片标记与数据；发送、清空或切会话时清掉。 */
	let pendingImages: PendingImage[] = [];
	/** 读图期间不接受第二张，避免标记插入顺序与提示错乱。 */
	let imageLoading = false;
	/** 清空图片时递增：上一张图晚到的读取结果不再落进新输入。 */
	let attachmentEpoch = 0;
	const clearAttachments = (): void => {
		pendingImages = [];
		attachmentEpoch += 1;
	};
	/**
	 * 排队中的消息，按发送顺序。
	 *
	 * 一轮进行中提交的内容放这里，本轮收尾后再逐条各发一轮。它们不进会话文件：排队消息还没
	 * 发生过，写进会话会让重放出现模型从未见过的用户消息。
	 */
	const queued: QueuedPrompt[] = [];
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
	/**
	 * 当前任务表:最近一次未收尾的 todo 调用卡片,常驻面板的数据源。
	 *
	 * 收尾后由 tool_start 处理整张卡落进对话流并清空这里。未收尾的表跨回合有效,
	 * 回合结束不清空;启动时由调用方从历史里带出最后一张未收尾的卡,切会话时随历史
	 * 一起替换。
	 */
	let currentTodo: TranscriptTodo | undefined = options.historyTodo;
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
	/** 运行状态的色调：重试、失败与阻断提示各用一种，别跟「正在进行」混成一样。 */
	let statusTone: "warning" | "error" | "notice" | undefined;
	let statusPhaseMs = 0;
	let statusElapsedMs = 0;
	let statusTokens = 0;

	/** 清零状态行的计时与用量:回合开始、命令切换、状态清空的场合都要回到同一起点。 */
	const resetStatusMeta = (): void => {
		statusElapsedMs = 0;
		statusTokens = 0;
	};
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
	let fileMenu: FileMenuState | undefined;
	/** 与命令补全同一套规则：Esc 主动收起后，输入不变就不再弹回来。 */
	let fileMenuDismissed = false;
	/** 当前 @ 片段对应的文件索引；同一次补全期间复用，换片段或关面板时丢弃。 */
	let fileFiles: readonly string[] | undefined;
	let fileIndexStart: number | undefined;
	/** 占据主区域的整屏页；打开期间视口只跟着它自己的滚动。 */
	let openPage: PageKind | undefined;
	/** 整屏页从顶部滚过的行数。 */
	let pageScrollTop = 0;
	/** 当前正在审批页里展示的计划；为空时计划页没有内容。 */
	let planReview: TranscriptPlan | undefined;
	/** 最近一份计划；/view-plan 与计划卡都从这里打开。 */
	let latestPlan: TranscriptPlan | undefined = options.historyPlan;
	/** 本轮刚提交、等回合结束后自动打开审批页的计划。 */
	let pendingPlan: TranscriptPlan | undefined;
	/** 检查点列表的数据快照；打开页面时取一次，翻动选择不重新扫索引。 */
	let checkpointList: readonly CheckpointEntry[] = [];
	let checkpointCursor = 0;
	/** 当前确认页要恢复的检查点；为空时确认页显示空态。 */
	let checkpointPreview: CheckpointPreview | undefined;
	/** 确认页取消后回到列表，而不是直接回对话流。 */
	let checkpointReturnToList = false;
	/** 防止连续 Enter 同时发起多个预览请求。 */
	let checkpointLoading = false;
	/** 恢复期间拒绝新输入，避免在工作区变化时开始下一轮。 */
	let restoringCheckpoint = false;
	/** 后台作业页的光标与当前输出页。 */
	let jobCursor = 0;
	let jobDetailId: string | undefined;
	/** 作业页与检查点页一样把动作条固定在底部。 */
	let jobReturnToList = false;
	/** 排好版的页面内容；宽度不变就复用，滚动与重绘都不必重排。 */
	let pageCache:
		| { readonly kind: PageKind; readonly width: number; readonly lines: readonly string[] }
		| undefined;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	/** 只在有作业运行时启动：空闲回合也要更新 Jobs bar 的耗时。 */
	let jobTimer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeJobs: () => void = () => {};
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
		const withPlan =
			options.planMode?.current() === true ? { ...info, planMode: true } : info;
		return mode === undefined ? withPlan : { ...withPlan, approval: mode };
	};

	/** 当前是否处于 Plan 模式；只读闸门在宿主，界面只负责显示与命令。 */
	const planning = (): boolean => options.planMode?.current() === true;

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
						? sessionMenuHeight(
								sessionMenu.items.length,
								options.sessionMenu?.fork !== undefined,
							)
						: commandMenu !== undefined
							? commandMenuHeight(commandMenu.items.length)
							: fileMenu !== undefined
								? fileMenuHeight(fileMenu.items.length)
								: 0;
	const menuOpen = (): boolean =>
		approvalPrompt !== undefined ||
		modelMenu !== undefined ||
		effortMenu !== undefined ||
		sessionMenu !== undefined ||
		commandMenu !== undefined ||
		fileMenu !== undefined;
	/** 抢输入焦点的面板:命令补全不抢(输入还在打字),模型/思考等级/会话面板是模态的。 */
	const modalMenuOpen = (): boolean =>
		modelMenu !== undefined || effortMenu !== undefined || sessionMenu !== undefined;
	/** 整屏页与菜单一样把输入框让给内容：紧凑页脚、不画光标。 */
	const compactFooter = (): boolean => menuOpen() || openPage !== undefined;
	const inputLineCount = (): number => {
		const width = terminalWidth();
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
	 * 常驻任务面板的高度:无任务表、空表或已收尾为 0;收起缩为一行,其余头行加条目。
	 * 高度只在 todo 调用与收展切换时变化(低频),主区域随之重排。
	 */
	const todoPanelHeight = (): number => {
		if (
			openPage !== undefined ||
			planning() ||
			currentTodo === undefined ||
			currentTodo.items.length === 0 ||
			todoCardFinished(currentTodo)
		) {
			return 0;
		}
		if (currentTodo.collapsed === true) return 1;
		return 1 + Math.min(currentTodo.items.length, TODO_PANEL_MAX_ITEMS);
	};

	/** 当前终端宽度;宽度变化是重建视图与重排面板的统一触发条件。 */
	const terminalWidth = (): number => Math.max(1, stdout.columns ?? DEFAULT_COLUMNS);

	/** 页脚之外的主区域高度:对话流、整屏页与命中判定都用这一个数。 */
	const runningJobs = (): readonly JobView[] =>
		options.jobs?.list().filter((job) => job.status === "running") ?? [];
	/** Jobs bar 只占一行；模态页与菜单打开时让位给内容。 */
	const jobBarHeight = (): number =>
		runningJobs().length > 0 &&
		openPage === undefined &&
		approvalPrompt === undefined &&
		!menuOpen()
			? 1
			: 0;

	/** 页脚上方的一行作业状态；有多个时只展示最新一条，完整列表在 /jobs。 */
	const jobBarLine = (width: number): string =>
		renderJobBarLine(options.jobs?.list() ?? [], width);

	const mainAreaHeight = (): number =>
		Math.max(0, terminalHeight(stdout) - footerHeight() - todoPanelHeight() - jobBarHeight());

	/**
	 * 输入行首行在终端里的 1 基行号。
	 *
	 * 光标定位与点击命中必须用同一份几何,否则页脚结构调整时两者会各错各的。
	 * 常驻任务面板夹在主区域与页脚之间,它占的行数同样要算进来——漏掉它,光标就落到
	 * 面板最后一行上,看起来像凭空多出一根竖线。
	 */
	const inputTopRow = (mainHeight: number): number => {
		const panel = todoPanelHeight();
		return compactFooter()
			? mainHeight + panel + menuHeight() + COMPACT_FOOTER_INPUT_ROW
			: mainHeight +
					panel +
					jobBarHeight() +
					FULL_FOOTER_INPUT_ROW +
					queueHeight(queued.length);
	};

	const markTranscriptDirty = (): void => {
		transcriptDirty = true;
	};


	/** 宽度、警告或内容变化时重建；其余帧直接复用。 */
	const currentTranscript = (width: number): TranscriptView => {
		const notice = noticeText();
		if (
			transcriptView === undefined ||
			transcriptDirty ||
			transcriptViewWidth !== width ||
			transcriptViewNotice !== notice
		) {
			transcriptView = buildTranscriptView(width, turns, notice);
			transcriptViewWidth = width;
			transcriptViewNotice = notice;
			transcriptDirty = false;
		}
		return transcriptView;
	};

	const render = (): void => {
		const width = terminalWidth();
		const height = terminalHeight(stdout);
		const mainHeight = Math.max(
			0,
			height - footerHeight() - todoPanelHeight() - jobBarHeight(),
		);
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
						// 转圈与扫光都表示「还在动」：重试仍在进行，失败、阻断与提示都是静止的
						symbol:
							statusTone === "error" || statusTone === "notice"
								? ""
								: (SPINNER_FRAMES[spinnerFrame] ?? ""),
						text: statusText,
						sweep: statusTone === undefined ? sweepPhase : undefined,
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
							? renderSessionMenu(
									width,
									sessionMenu,
									options.sessionMenu?.fork !== undefined,
								)
							: commandMenu !== undefined
								? renderCommandMenu(width, commandMenu)
								: fileMenu !== undefined
									? renderFileMenu(width, fileMenu)
									: [];
		const inputLines = inputView(input, width, inputCursor);
		// 输入以已注册的命令开头时把命令本身着色，参数保持正文色
		const typedCommand = commandNameOf(input);
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
							focused && !modalMenuOpen() && openPage === undefined,
							undefined,
							currentInfo(),
							{ leadingGap: false, showStatus: false, cursor: inputCursor, commandLength },
						)
					: renderFooter(width, input, focused, status, currentInfo(), {
							cursor: inputCursor,
							commandLength,
							queued: queued.map((item) => item.text),
						});
			const transcriptShown = openPage === undefined && (hasInput || noticeText() !== undefined);
			// 运行中的行按当前帧重建转圈与扫光；没有动画行时这只是原样返回缓存行
			const animation: AnimationFrame = { spinner: SPINNER_FRAMES[spinnerFrame] ?? "", sweepPhase };
			const main =
				openPage === "plan"
					? planPageLines(width, mainHeight)
					: openPage === "checkpoints" || openPage === "checkpoint"
						? checkpointPageLines(width, mainHeight)
						: openPage === "jobs" || openPage === "job"
							? jobPageLines(width, mainHeight)
							: openPage === "sandbox"
								? sandboxPageFrame(width, mainHeight)
								: openPage !== undefined
									? renderPage(pageLines(openPage, width), mainHeight, pageScrollTop)
									: transcriptShown
										? renderTranscriptView(view, mainHeight, scrollTop, animation)
										: renderMain(width, mainHeight, options.version);
		const mainLines = [...main];
		// 常驻任务面板:贴在页脚上方,任务表存在且非空时显示;Plan 模式隐藏旧任务表
		const panelLines =
			openPage === undefined && !planning() && currentTodo !== undefined
				? [...todoPanelLines(currentTodo, width, animation)]
				: [];
		// 后台作业只占一行，放在任务面板与页脚之间；没有运行中作业时不占高度
		const jobBar = jobBarHeight() > 0 ? [jobBarLine(width)] : [];
		// 整屏自上而下：主区域、任务面板、Jobs bar、选择面板、页脚
		const lines = [
			...mainLines,
			...panelLines,
			...jobBar,
			...menuLines,
			...footer,
		].slice(0, height);
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
		const width = terminalWidth();
		const mainHeight = mainAreaHeight();
		return Math.max(0, measureTranscriptView(currentTranscript(width), mainHeight).scrollLines - mainHeight);
	};

	/**
	 * 双击对话流里的可展开行。
	 *
	 * 审批卡显示时也复用这一套：审批是模态的，但上方的对话流仍然可以查看，不能被一起冻结。
	 */
	const toggleTranscriptAt = (
		row: number,
		column: number,
		mainHeight: number,
		width: number,
	): boolean => {
		if (row > mainHeight || column >= width - 1) return false;
		const view = currentTranscript(width);

		const plan = planHeaderInView(view, mainHeight, scrollTop, row);
		if (plan !== undefined) {
			// 审批卡还在等回答时不开第二个模态页，先让使用者处理当前审批
			if (approvalPrompt === undefined) {
				lastClick = undefined;
				openPlanReview(plan);
				render();
			}
			return true;
		}

		const block = thinkingHeaderInView(view, mainHeight, scrollTop, row);
		if (block !== undefined) {
			block.expanded = !block.expanded;
			markTranscriptDirty();
			lastClick = undefined;
			// 保持标题在点击时的屏幕位置：跟随到底部会让长内容直接跳到末尾
			follow = false;
			render();
			return true;
		}

		const group = toolGroupHeaderInView(view, mainHeight, scrollTop, row);
		if (group !== undefined) {
			group.expanded = !group.expanded;
			markTranscriptDirty();
			lastClick = undefined;
			follow = false;
			render();
			return true;
		}

		const tool = toolHeaderInView(view, mainHeight, scrollTop, row);
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
			return true;
		}

		const todo = todoHeaderInView(view, mainHeight, scrollTop, row);
		if (todo !== undefined) {
			todo.collapsed = todo.collapsed !== true;
			markTranscriptDirty();
			lastClick = undefined;
			follow = false;
			render();
			return true;
		}

		const subagents = subagentGroupHeaderInView(view, mainHeight, scrollTop, row);
		if (subagents !== undefined) {
			subagents.expanded = subagents.expanded !== true;
			markTranscriptDirty();
			lastClick = undefined;
			follow = false;
			render();
			return true;
		}

		// 失败的子代理清单行:双击展开/收起失败原因
		const failedRow = subagentFailureRowInView(view, mainHeight, scrollTop, row);
		if (failedRow !== undefined) {
			const member = failedRow.group.members.find((item) => item.callId === failedRow.callId);
			if (member !== undefined) {
				member.expanded = member.expanded !== true;
				markTranscriptDirty();
				lastClick = undefined;
				follow = false;
				render();
				return true;
			}
		}
		return false;
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
		if (jobTimer !== undefined) {
			clearInterval(jobTimer);
			jobTimer = undefined;
		}
		unsubscribeJobs();
		options.jobs?.shutdown();
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
			if (openPage === "plan") closePlanReview();
			else if (openPage === "checkpoints" || openPage === "checkpoint") closeCheckpointPage();
			else if (openPage === "jobs" || openPage === "job") closeJobPage();
			else openPage = undefined;
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

	const setStatus = (text: string, tone?: "warning" | "error" | "notice"): void => {
		statusText = text;
		statusTone = tone;
		statusPhaseMs = 0;
		statusPhaseStartedAt = Date.now();
	};

	/** 立即清空运行状态。完成后不保留额外的提示，回复本身就是结束信号。 */
	const clearStatus = (): void => {
		statusText = undefined;
		statusTone = undefined;
		statusPhaseMs = 0;
		resetStatusMeta();
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
				// 运行中的子代理组头:计数与耗时都在变,有组在跑才标脏重建
				let subagentsRunning = false;
				for (const line of activeTurn.lines) {
					if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
					if (line.members.some((member) => member.status === "running")) {
						subagentsRunning = true;
						line.durationMs = undefined;
					}
				}
				if (subagentsRunning) markTranscriptDirty();
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

	/**
	 * 计划提交：对话流只放一张计划卡，完整正文留给审批页。
	 *
	 * 空计划不建卡，让它落回普通工具行，工具返回的错误才有地方显示。有效计划在回合结束时
	 * 自动打开审批页；latest 同时更新，供 /view-plan 重新打开。
	 */
	const handlePlanStart = (
		active: ActiveTurn,
		event: Extract<AgentEvent, { type: "tool_start" }>,
	): boolean => {
		if (event.name !== "present_plan" || !planning()) return false;
		const text = event.args["plan"];
		if (typeof text !== "string" || text.trim().length === 0) return false;

		const plan: TranscriptPlan = { kind: "plan", text };
		appendLine(active, plan);
		latestPlan = plan;
		pendingPlan = plan;
		return true;
	};

	/**
	 * 任务卡片按生命周期分流：未收尾的进常驻面板，已收尾的落回对话流并清空面板。
	 * 解析不了的形状返回 false 落回普通工具行，后面校验阶段的错误信息才有行可挂。
	 */
	const handleTodoCardStart = (
		active: ActiveTurn,
		event: Extract<AgentEvent, { type: "tool_start" }>,
	): boolean => {
		// Plan 模式下任务工具不在工具清单里；幻觉调用应落回普通错误行，不更新任务面板
		if (event.name !== "todo" || planning()) return false;
		const card = todoCardFromArgs(event.args);
		if (card === undefined) return false;

		// 空表表示清空；面板与对话流都不留痕迹
		if (card.items.length === 0) {
			currentTodo = undefined;
			return true;
		}

		// 收尾：整张卡作为历史落进对话流，面板退出
		if (todoCardFinished(card)) {
			card.running = false;
			appendLine(active, card);
			currentTodo = undefined;
			return true;
		}

		card.running = true;
		const current = card.items.find((item) => item.status === "in_progress");
		if (current !== undefined) {
			// 计时起点：同一任务在上一张卡片里也进行时继承，否则从现在起算
			const previousCard = currentTodo;
			const previous = previousCard?.items.find((item) => item.status === "in_progress");
			card.taskStartedAt =
				previousCard?.taskStartedAt !== undefined && previous?.content === current.content
					? previousCard.taskStartedAt
					: Date.now();
		}
		currentTodo = card;
		return true;
	};

	/**
	 * 子代理调用进组:本回合已有组就追加成员,否则开新组。
	 * 返回 true 表示这个调用已被组消化,不再落普通工具行。
	 */
	const handleSubagentStart = (
		active: ActiveTurn,
		event: Extract<AgentEvent, { type: "tool_start" }>,
	): boolean => {
		if (event.name !== "subagent" || planning()) return false;
		const task = typeof event.args["task"] === "string" ? event.args["task"] : "";
		const last = active.lines.at(-1);
		if (typeof last === "object" && last !== null && last.kind === "subagentGroup") {
			last.members.push({ callId: event.callId, task, status: "running" });
		} else {
			appendLine(active, {
				kind: "subagentGroup",
				members: [{ callId: event.callId, task, status: "running" }],
				startedAt: Date.now(),
				expanded: false,
			});
		}
		return true;
	};

	/** 子代理结果挂回组里的成员:终态与耗时、失败原因都在这里落定。 */
	const handleSubagentEnd = (
		active: ActiveTurn,
		event: Extract<AgentEvent, { type: "tool_end" }>,
	): boolean => {
		if (event.name !== "subagent") return false;
		for (const line of active.lines) {
			if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
			const member = line.members.find((item) => item.callId === event.callId);
			if (member === undefined) continue;
			const details = event.details as
				| { durationMs?: number; lastActivity?: string; steps?: number; totalTokens?: number }
				| undefined;
			member.status = event.isError ? "failed" : "done";
			member.durationMs = details?.durationMs ?? event.durationMs;
			member.steps = details?.steps;
			member.totalTokens = details?.totalTokens;
			if (event.isError) member.failure = event.content ?? event.summary;
			// 组内最后一个还在跑的结束了,整组的总耗时与 token 合计定格
			if (line.members.every((item) => item.status !== "running")) {
				line.durationMs = Date.now() - line.startedAt;
				line.totalTokens = line.members.reduce(
					(sum, item) => sum + (item.totalTokens ?? 0),
					0,
				);
			}
			return true;
		}
		return false;
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
				setStatus(WAITING_FOR_MODEL);
				break;
			case "writing_tool_call":
				// 参数还在流里，工具没开始跑；不能提前显示成 Running
				setStatus(WRITING_TOOL_CALL);
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
				if (handlePlanStart(active, event)) {
					setStatus(WAITING_FOR_MODEL);
					break;
				}
				if (handleTodoCardStart(active, event)) {
					// 任务表不产生模型等待：这一行已经交给面板处理，状态只需离开响应阶段
					setStatus(RUNNING_TOOL);
					break;
				}
				if (handleSubagentStart(active, event)) {
					setStatus(WAITING_FOR_SUBAGENT);
					break;
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
				// 子代理的每一步进度仍是「等它回来」，不能显示成普通工具在跑
				setStatus(isSubagentCall(active.lines, event.callId) ? WAITING_FOR_SUBAGENT : RUNNING_TOOL);
				break;
			case "tool_end":
				// 有效计划没有普通工具行可挂结果；无效调用仍按失败行处理
				if (
					event.name === "present_plan" &&
					findTopLevelToolByCallId(active.lines, event.callId) === undefined
				) {
					setStatus(WAITING_FOR_MODEL);
					break;
				}
				if (handleSubagentEnd(active, event)) {
					markTranscriptDirty();
					// 并行派发时还有一个在跑就继续等它，不能提前回到模型等待
					setStatus(hasRunningSubagent(active.lines) ? WAITING_FOR_SUBAGENT : WAITING_FOR_MODEL);
					break;
				}
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
				// 工具结果已经写回会话，下一回合的请求就要发出
				setStatus(WAITING_FOR_MODEL);
				break;
			case "compaction_start":
				appendLine(
					active,
					`· compacting context (${event.messages} messages, ~${event.tokensBefore} tokens)`,
				);
				setStatus(COMPACTING_CONTEXT);
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
				// 与这一轮无关的提示走状态行：它不该占对话流的位置，看一眼就够了；
				// 提示不是活动，不能带着转圈让人以为还在跑
				setStatus(event.message, "notice");
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
				// 动作在前：先说明系统正在重试，再用冒号补上这一次失败的原因
				const retry = `Retrying (${event.attempt}/${event.maxAttempts})`;
				const reason = shortReason(event.reason).replace(/[.…]+$/, "");
				setStatus(reason.length === 0 ? `${retry}...` : `${retry}: ${reason}...`, "warning");
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
				// 使用者主动停下不是错误：用中性说明，不染错误色，也不加错误标记。
				// 状态行直接清空，不再留一个「已停下」的静态结局
				appendLine(active, { text: INTERRUPTED, kind: "info" });
				active.outcome = "aborted";
				clearStatus();
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
					text: `Error: Failed to switch model: ${describeError(error)}`,
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
					text: `Error: Failed to set effort: ${describeError(error)}`,
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
			const message = describeError(error);
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
	const switchSession = (id: string, action: "select" | "fork" = "select"): void => {
		const source = options.sessionMenu;
		if (source === undefined) return;

		const forking = action === "fork";
		let result: SessionSwitchResult;
		try {
			const run = forking ? source.fork : source.select;
			if (run === undefined) throw new Error("Session forking is unavailable");
			result = run(id);
		} catch (error) {
			follow = true;
			const message = describeError(error);
			appendCommandTurn(forking ? "/fork" : "/session", [
				{
					kind: "error",
					text: `Error: Failed to ${forking ? "fork" : "switch"} session: ${message}`,
				},
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
		// 任务表与计划都属于会话:随历史一起换成新会话的内容
		currentTodo = result.todo;
		latestPlan = result.plan;
		pendingPlan = undefined;
		if (openPage === "plan") closePlanReview();
		else planReview = undefined;
		closeCheckpointPage();
		markTranscriptDirty();
		initialScroll = false;
		scrollTop = 0;
		follow = true;
		hasInput = turns.length > 0;
		// 上一个会话留下的状态/错误不该跟着出现在新会话里
		clearStatus();
		// 排队消息是发给旧会话的，换会话后没有意义
		queued.length = 0;
		fileMenu = undefined;
		fileFiles = undefined;
		fileIndexStart = undefined;
		clearAttachments();
		if (forking) {
			const origin = result.fork?.sourceId ?? id;
			const copied = result.fork?.copied ?? 0;
			appendCommandTurn("/fork", [
				`Forked from ${origin} · ${copied} ${copied === 1 ? "entry" : "entries"} copied`,
				"Workspace unchanged · checkpoints start fresh within the fork.",
				...result.warnings,
			]);
			return;
		}
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

	/** 会话菜单里按 f：从选中会话的末尾分叉，并切到新会话。 */
	const forkSelectedSession = (): void => {
		if (sessionMenu === undefined) return;

		const item = sessionMenu.items[sessionMenu.cursor];
		sessionMenu = undefined;
		commandMenu = undefined;
		modelMenu = undefined;
		effortMenu = undefined;
		setInput("");
		if (item === undefined) {
			render();
			return;
		}
		switchSession(item.id, "fork");
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
		if (modalMenuOpen()) return;
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

	/** 收起 @ 面板；dismissed 表示使用者主动按了 Esc，输入不变就不再弹回来。 */
	const closeFileMenu = (dismissed = false): void => {
		fileMenu = undefined;
		fileFiles = undefined;
		fileIndexStart = undefined;
		if (dismissed) fileMenuDismissed = true;
	};

	/**
	 * 按光标所在的 @ 片段刷新文件面板。
	 *
	 * 每次从一个片段重新打开时重扫文件清单（使用者可能刚让模型建了新文件）；同一次补全里
	 * 只过滤缓存，避免每敲一个字都遍历一遍工作区。
	 */
	const updateFileMenu = (): void => {
		const source = options.files;
		if (source === undefined) {
			closeFileMenu();
			return;
		}
		if (modalMenuOpen() || commandMenu !== undefined || input.startsWith("/")) {
			closeFileMenu();
			return;
		}
		if (fileMenuDismissed) {
			fileMenu = undefined;
			return;
		}

		const token = findAtToken(input, inputCursor);
		if (token === undefined) {
			closeFileMenu();
			return;
		}

		if (fileFiles === undefined || fileIndexStart !== token.start) {
			fileIndexStart = token.start;
			try {
				fileFiles = source.list().filter((path) => !/[\u0000-\u001f\u007f]/.test(path));
			} catch (error) {
				fileFiles = [];
				setStatus(`Could not list files: ${errorLine(error)}`, "error");
				scheduleStatusClear();
			}
		}

		const items = filterFiles(fileFiles, token.query);
		if (items.length === 0) {
			// 索引留着：继续输入出现匹配时不必再扫一遍
			fileMenu = undefined;
			return;
		}

		const previous = fileMenu?.items[fileMenu.cursor];
		const kept = previous === undefined ? -1 : items.indexOf(previous);
		const cursor = kept >= 0 ? kept : 0;
		fileMenu = { items, token, cursor, scrollTop: keepVisible(0, cursor, items.length) };
	};

	const moveFileMenu = (delta: number): void => {
		if (fileMenu === undefined) return;
		fileMenu.cursor = Math.min(
			fileMenu.items.length - 1,
			Math.max(0, fileMenu.cursor + delta),
		);
		fileMenu.scrollTop = keepVisible(
			fileMenu.scrollTop,
			fileMenu.cursor,
			fileMenu.items.length,
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
		images: readonly ImageAttachment[],
		run: (onEvent: AgentEventListener, signal: AbortSignal) => Promise<void>,
	): void => {
		const shown = prompt.trim();
		const turn: LiveTurn = {
			prompt: shown.length > 0 ? shown : images.length > 0 ? "[image]" : "",
			response: [],
		};
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
		resetStatusMeta();
		if (statusClearTimer !== undefined) {
			clearTimeout(statusClearTimer);
			statusClearTimer = undefined;
		}
		setStatus(WAITING_FOR_MODEL);

		const width = terminalWidth();
		const mainHeight = mainAreaHeight();
		scrollTop = measureTranscriptView(currentTranscript(width), mainHeight).lastPromptStart;
		startSpinner();
		render();

		void run(onEvent, active.controller.signal)
			.catch((error) => {
				if (finished || activeTurn !== active) return;
				closeThinking(active);
				appendLine(active, {
					text: `Error: ${describeError(error)}`,
					kind: "error",
				});
				active.outcome = "error";
				setStatus(ERROR_STATUS, "error");
			})
			.finally(() => {
				if (activeTurn !== active) return;
				closeThinking(active);
				closeText(active);
				// 回合结束:还留在面板的任务表退回静态,转圈与扫光只在运行期间存在
				if (currentTodo?.running === true) currentTodo.running = false;
				for (const line of active.lines) {
					// 子代理组冻结:没等到结果的成员按失败落定,总耗时定格
					if (typeof line === "object" && line !== null && line.kind === "subagentGroup") {
						for (const member of line.members) {
							if (member.status === "running") {
								member.status = active.outcome === "done" ? "done" : "failed";
								member.durationMs = Date.now() - line.startedAt;
								if (member.status === "failed") member.failure = "the subagent never reported back";
							}
						}
						line.durationMs = Date.now() - line.startedAt;
					}
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
				const completedPlan = active.outcome === "done" ? pendingPlan : undefined;
				pendingPlan = undefined;
				if (completedPlan !== undefined) openPlanReview(completedPlan);
				options.agent?.refreshInfo();
				statusElapsedMs = Date.now() - active.startedAt;
				statusTokens = active.tokensUsed;
				if (active.outcome === "aborted") {
					// 主动停下由对话流里的 Interrupted 说明，状态行不再留结局
					clearStatus();
				} else if (active.outcome === "done") {
					clearStatus();
				} else {
					setStatus(ERROR_STATUS, "error");
					scheduleStatusClear();
				}
				render();
				if (active.outcome !== "aborted") {
					notify(active.outcome === "done" ? "Turn complete" : "Turn failed");
				}
				// 排队消息接上：中止是使用者的明确意图，默认不替他续发；只有 Esc 请求过立即发送才例外。
				// 计划审批页打开时先暂停队列，否则排队消息会越过审批直接进入下一轮。
				const sendQueued = sendQueuedAfterAbort;
				sendQueuedAfterAbort = false;
				if (
					completedPlan === undefined &&
					(active.outcome !== "aborted" || sendQueued) &&
					queued.length > 0
				) {
					drainQueue();
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
		resetStatusMeta();
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
					text: `Error: ${describeError(error)}`,
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

		// 每条命令的处理独立成函数:分支条件只剩名字匹配,新增命令加一个处理器
		const handlers: Readonly<Record<string, () => void>> = {
			model: () => executeModelCommand(args),
			effort: () => executeEffortCommand(args),
			session: () => executeSessionCommand(args),
			fork: () => executeForkCommand(),
			compact: () => executeCompactCommand(),
			plan: () => executePlanCommand(args),
			"view-plan": () => executeViewPlanCommand(),
			undo: () => executeUndoCommand(),
			checkpoints: () => executeCheckpointsCommand(),
			sandbox: () => {
				if (options.sandbox !== undefined) showPage("sandbox");
			},
			jobs: () => executeJobsCommand(),
			help: () => showPage("help"),
			skills: () => showPage("skills"),
			mcps: () => showPage("mcps"),
		};
		const handler = handlers[command.name];
		if (handler !== undefined) {
			// 整屏页期间输入框不接受按键，命令名一律不留在输入框里
			if (
				command.name === "help" ||
				command.name === "skills" ||
				command.name === "mcps" ||
				command.name === "sandbox"
			) {
				setInput("");
			}
			handler();
			render();
			return;
		}

		// 插件命令可能有任意副作用，Plan 模式下一律不执行
		if (planning()) {
			setInput("");
			resetStatusMeta();
			setStatus("Plugin commands are unavailable in Plan mode", "notice");
			scheduleStatusClear();
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

	/** /model:无参数开面板,带参数直接选中那个模型。 */
	const executeModelCommand = (args: string): void => {
		const source = options.modelMenu;
		if (source === undefined) {
			setInput("");
			resetStatusMeta();
			setStatus(CONFIGURATION_REQUIRED, "notice");
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
	};

	/** /effort:无参数开面板,带参数直接选中那一档。 */
	const executeEffortCommand = (args: string): void => {
		const source = options.effortMenu;
		if (source === undefined) {
			setInput("");
			resetStatusMeta();
			setStatus(CONFIGURATION_REQUIRED, "notice");
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
	};

	/** /session:无参数开面板,带参数直接切换到那个会话。 */
	const executeSessionCommand = (args: string): void => {
		const source = options.sessionMenu;
		if (source === undefined) {
			setInput("");
			resetStatusMeta();
			setStatus(SESSION_UNAVAILABLE, "notice");
			return;
		}

		const target = args.trim();
		if (target.length === 0) {
			openSessionMenu();
			return;
		}
		setInput("");
		switchSession(target);
	};

	/** /fork:从当前会话的当前末尾分叉，并切换到新会话。 */
	const executeForkCommand = (): void => {
		const source = options.sessionMenu;
		setInput("");
		if (source === undefined || source.fork === undefined) {
			resetStatusMeta();
			setStatus("Session forking is unavailable in this session", "notice");
			return;
		}

		let items: readonly SessionMenuItem[];
		try {
			items = source.list();
		} catch (error) {
			follow = true;
			const message = describeError(error);
			appendCommandTurn("/fork", [{ kind: "error", text: `Error: Failed to list sessions: ${message}` }]);
			return;
		}
		const current = items.find((item) => item.current);
		if (current === undefined) {
			follow = true;
			appendCommandTurn("/fork", [
				{ kind: "error", text: "Error: The current session is not in the session list." },
			]);
			return;
		}
		switchSession(current.id, "fork");
	};

	/** 把一张图插成正文标记；名称重复时加序号，发送时靠标记找回数据。 */
	const insertImageMarker = (image: ImageAttachment, at: number): void => {
		// 标记已被删掉的图片不再占名额；顺便把失效数据清掉
		pendingImages = pendingImages.filter((item) => input.includes(item.token));
		const used = new Set(pendingImages.map((item) => item.image.name));
		const name = uniqueImageName(image.name, used);
		const stored: ImageAttachment = { ...image, name };
		const error = imageLimitError(
			pendingImages.map((item) => item.image),
			stored,
		);
		if (error !== undefined) {
			setStatus(error, "warning");
			scheduleStatusClear();
			render();
			return;
		}

		const position = Math.min(Math.max(0, at), input.length);
		const before = input.slice(0, position);
		const after = input.slice(position);
		const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
		// 末尾也补一个空格：连续输入文字或再插一张图时不会和标记粘在一起
		const trail = after.length === 0 || !/^\s/.test(after) ? " " : "";
		const token = imageMarker(name);
		const insertion = `${lead}${token}${trail}`;
		setInput(`${before}${insertion}${after}`, position + insertion.length);
		pendingImages.push({ token, image: stored });
		closeFileMenu();

		if (options.imagesSupported?.() === false) {
			setStatus(
				`Attached ${name}; this model does not declare image input, so it will receive a placeholder`,
				"warning",
			);
		} else {
			setStatus(`Attached ${name}`, "notice");
		}
		scheduleStatusClear();
		render();
	};

	/**
	 * 读图后再把标记插进输入框。
	 *
	 * 位置在开始读取时确定；读完之前禁止发送，避免出现「标记在、图片没跟上」的半轮消息。
	 */
	const readAndInsertImage = (
		read: () => Promise<ImageAttachment>,
		status: string,
		at: number,
	): void => {
		if (imageLoading) {
			setStatus("Still reading an image; try again in a moment", "notice");
			scheduleStatusClear();
			render();
			return;
		}
		const epoch = attachmentEpoch;
		const position = Math.min(Math.max(0, at), input.length);
		imageLoading = true;
		setStatus(status);
		render();
		void read()
			.then((image) => {
				if (epoch === attachmentEpoch) insertImageMarker(image, position);
			})
			.catch((error: unknown) => {
				if (epoch !== attachmentEpoch) return;
				setStatus(`Image: ${errorLine(error)}`, "error");
				scheduleStatusClear();
			})
			.finally(() => {
				imageLoading = false;
				render();
			});
	};

	const attachImagePath = (path: string, at = inputCursor): void => {
		const source = options.images;
		if (source === undefined) return;
		readAndInsertImage(() => source.read(path), "Reading image...", at);
	};

	const attachClipboardImage = (at = inputCursor): void => {
		const source = options.images;
		if (source === undefined) {
			setStatus("Image input is unavailable in this session", "notice");
			scheduleStatusClear();
			render();
			return;
		}
		readAndInsertImage(() => source.clipboard(), "Reading clipboard image...", at);
	};

	/** 选中 @ 项：文本文件写回 `@相对路径`；图片读进来后在原位置插入正文标记。 */
	const insertFileReference = (): void => {
		const menu = fileMenu;
		if (menu === undefined) return;
		const path = menu.items[menu.cursor];
		if (path === undefined) return;
		const token = menu.token;

		if (isImagePath(path) && options.images !== undefined) {
			// 先把 @片段去掉，图片读完后在同一位置插入标记
			const next = input.slice(0, token.start) + input.slice(token.end);
			setInput(next, token.start);
			closeFileMenu();
			updateCommandMenu();
			attachImagePath(path, token.start);
			return;
		}

		const reference = formatFileReference(path);
		const next = input.slice(0, token.start) + reference + " " + input.slice(token.end);
		const cursor = token.start + reference.length + 1;
		setInput(next, cursor);
		closeFileMenu();
		updateCommandMenu();
		render();
	};

	/**
	 * 拖入图片时终端会粘贴一段路径。只有整段内容就是一个现有图片文件才有动作，
	 * 夹着说明文字或换行的粘贴仍然按普通文本处理。
	 */
	const draggedImagePath = (chunk: string): string | undefined => {
		const source = options.images;
		if (source === undefined) return undefined;
		const trimmed = chunk.trim();
		let candidate = trimmed;
		if (trimmed.startsWith(PASTE_START)) {
			if (!trimmed.endsWith(PASTE_END)) return undefined;
			candidate = trimmed.slice(PASTE_START.length, -PASTE_END.length);
		}
		if (candidate.length === 0 || candidate.length > 4096) return undefined;
		if (/[\r\n\x1b]/.test(candidate)) return undefined;
		return source.detect(candidate);
	};

	/** /compact:立即压缩一轮上下文。 */
	const executeCompactCommand = (): void => {
		const compact = options.agent?.compact;
		setInput("");
		if (compact === undefined) {
			resetStatusMeta();
			setStatus(CONFIGURATION_REQUIRED, "notice");
			return;
		}
		startRun("/compact", [], compact);
	};

	/**
	 * /plan:开关只读规划。
	 *
	 * 带任务时开启并直接规划那一轮；不带参数时切换开关。一轮进行中不允许切换，
	 * 否则提示词与工具清单会在同一轮里前后不一致。
	 */
	const executePlanCommand = (args: string): void => {
		const source = options.planMode;
		setInput("");
		if (source === undefined) {
			resetStatusMeta();
			setStatus("Plan mode is unavailable in this session", "notice");
			return;
		}
		if (activeTurn !== undefined) {
			resetStatusMeta();
			setStatus("/plan is unavailable while a turn is running", "notice");
			return;
		}

		const task = args.trim();
		const enabled = task.length > 0 || !source.current();
		try {
			if (source.current() !== enabled) source.select(enabled);
		} catch (error) {
			resetStatusMeta();
			setStatus(
				`Failed to switch Plan mode: ${describeError(error)}`,
				"error",
			);
			scheduleStatusClear();
			return;
		}

		if (task.length > 0) {
			launch(task);
			return;
		}
		// 模式本身由徽标表达；状态行留给这一轮真正的运行状态
		clearStatus();
	};

	/** /view-plan:重新打开最近一份计划；没有计划时只给提示。 */
	const executeViewPlanCommand = (): void => {
		setInput("");
		if (latestPlan === undefined) {
			resetStatusMeta();
			setStatus("No plan yet. Use /plan to write one.", "notice");
			scheduleStatusClear();
			return;
		}
		openPlanReview(latestPlan);
	};

	/** 关闭检查点列表/确认页，清掉临时数据。 */
	const closeCheckpointPage = (): void => {
		if (openPage === "checkpoints" || openPage === "checkpoint") openPage = undefined;
		checkpointPreview = undefined;
		checkpointList = [];
		checkpointCursor = 0;
		checkpointLoading = false;
		checkpointReturnToList = false;
		pageScrollTop = 0;
	};

	/** 打开检查点列表；索引已在内存里，不需要异步等待。 */
	const openCheckpointList = (): void => {
		const source = options.checkpoints;
		if (source === undefined || !source.available()) {
			resetStatusMeta();
			setStatus(source?.error() ?? "Checkpoints are unavailable in this workspace", "notice");
			scheduleStatusClear();
			return;
		}
		checkpointList = source.list();
		checkpointCursor = 0;
		checkpointPreview = undefined;
		checkpointReturnToList = false;
		checkpointLoading = false;
		showPage("checkpoints");
	};

	/** 选中列表项后读取实际差异，再打开确认页。 */
	const loadCheckpointPreview = (entry: CheckpointEntry): void => {
		const source = options.checkpoints;
		if (source === undefined || !source.available() || checkpointLoading) return;
		checkpointLoading = true;
		render();
		void source
			.preview(entry.id)
			.then((preview) => {
				checkpointLoading = false;
				if (finished) return;
				if (openPage !== "checkpoints") {
					render();
					return;
				}
				if (preview.changes.length === 0) {
					openPage = undefined;
					resetStatusMeta();
					setStatus("No file changes to restore", "notice");
					scheduleStatusClear();
					render();
					return;
				}
				checkpointPreview = preview;
				checkpointReturnToList = true;
				showPage("checkpoint");
				render();
			})
			.catch((error) => {
				checkpointLoading = false;
				if (finished) return;
				if (openPage !== "checkpoints") {
					render();
					return;
				}
				openPage = undefined;
				resetStatusMeta();
				appendCommandTurn("/checkpoints", [
					{
						kind: "error",
						text: `Error: ${describeError(error)}`,
					},
				]);
				setStatus(ERROR_STATUS, "error");
				scheduleStatusClear();
				render();
			});
	};

	/** /undo:取最近一个与当前工作区有差异的回合检查点。 */
	const executeUndoCommand = (): void => {
		setInput("");
		const source = options.checkpoints;
		if (source === undefined || !source.available()) {
			resetStatusMeta();
			setStatus(source?.error() ?? "Checkpoints are unavailable in this workspace", "notice");
			scheduleStatusClear();
			return;
		}
		if (checkpointLoading || restoringCheckpoint) return;

		checkpointLoading = true;
		resetStatusMeta();
		setStatus("Reading checkpoints...", "notice");
		void source
			.latestUndoable()
			.then((preview) => {
				checkpointLoading = false;
				if (finished) return;
				clearStatus();
				if (preview === undefined) {
					setStatus("No file changes to undo", "notice");
					scheduleStatusClear();
					render();
					return;
				}
				checkpointPreview = preview;
				checkpointReturnToList = false;
				showPage("checkpoint");
				render();
			})
			.catch((error) => {
				checkpointLoading = false;
				if (finished) return;
				resetStatusMeta();
				setStatus(
					`Undo unavailable: ${describeError(error)}`,
					"error",
				);
				scheduleStatusClear();
				render();
			});
	};

	/** /checkpoints:浏览全部检查点。 */
	const executeCheckpointsCommand = (): void => {
		setInput("");
		openCheckpointList();
	};

	/**
	 * 恢复当前确认页里的检查点。
	 *
	 * 先关页面再恢复：恢复要跑 git，状态行是唯一能显示进度的地方；失败时通过对话流
	 * 的错误行留下原因，不把用户困在一个没有反馈的页面里。
	 */
	const restoreCheckpoint = (): void => {
		const preview = checkpointPreview;
		const source = options.checkpoints;
		if (
			preview === undefined ||
			preview.changes.length === 0 ||
			source === undefined ||
			restoringCheckpoint
		) {
			return;
		}
		if (options.jobs?.list().some((job) => job.status === "running") === true) {
			// 后台作业可能正在写同一批文件；先让它停下来，否则恢复出来的工作区不是任何一个稳定状态
			closeCheckpointPage();
			resetStatusMeta();
			setStatus("Stop background jobs before restoring files", "notice");
			scheduleStatusClear();
			render();
			return;
		}

		restoringCheckpoint = true;
		checkpointPreview = undefined;
		checkpointList = [];
		checkpointCursor = 0;
		checkpointLoading = false;
		checkpointReturnToList = false;
		openPage = undefined;
		pageScrollTop = 0;
		setInput("");
		resetStatusMeta();
		setStatus("Restoring checkpoint...", "notice");
		render();

		void source
			.restore(preview.entry.id)
			.then((result) => {
				restoringCheckpoint = false;
				if (finished) return;
				const verb = result.entry.kind === "safety" ? "Restored" : "Undid";
				const removed = result.removed > 0 ? `, ${result.removed} removed` : "";
				appendCommandTurn("/undo", [
					{
						kind: "info",
						text: `${verb} ${result.entry.label} · ${result.restored} restored${removed}`,
					},
				]);
				clearStatus();
				render();
			})
			.catch((error) => {
				restoringCheckpoint = false;
				if (finished) return;
				appendCommandTurn("/undo", [
					{
						kind: "error",
						text: `Error: ${describeError(error)}`,
					},
				]);
				setStatus(ERROR_STATUS, "error");
				scheduleStatusClear();
				render();
			});
	};

	/** 让检查点列表的光标始终落在可见区内。 */
	const ensureCheckpointVisible = (): void => {
		const rows = Math.max(1, mainAreaHeight() - CHECKPOINT_ACTION_HEIGHT);
		const row = (checkpointLoading ? 3 : 2) + checkpointCursor;
		if (row < pageScrollTop) pageScrollTop = row;
		else if (row >= pageScrollTop + rows) pageScrollTop = row - rows + 1;
	};

	/** /jobs:打开后台作业列表。 */
	const openJobsPage = (): void => {
		if (options.jobs === undefined) {
			resetStatusMeta();
			setStatus("Background jobs are unavailable in this session", "notice");
			scheduleStatusClear();
			return;
		}
		jobCursor = 0;
		jobDetailId = undefined;
		jobReturnToList = false;
		showPage("jobs");
	};

	const executeJobsCommand = (): void => {
		setInput("");
		openJobsPage();
	};

	/** 关闭作业列表/输出页。 */
	const closeJobPage = (): void => {
		if (openPage === "jobs" || openPage === "job") openPage = undefined;
		jobDetailId = undefined;
		jobCursor = 0;
		jobReturnToList = false;
		pageScrollTop = 0;
	};

	const jobsOf = (): readonly JobView[] => options.jobs?.list() ?? [];

	const selectedJob = (): JobView | undefined => {
		const jobs = jobsOf();
		if (jobs.length === 0) return undefined;
		jobCursor = Math.min(jobCursor, jobs.length - 1);
		return jobs[jobCursor];
	};

	const openJobDetail = (job: JobView): void => {
		jobDetailId = job.id;
		jobReturnToList = true;
		showPage("job");
		render();
	};

	const killSelectedJob = (): void => {
		const job = selectedJob();
		if (job === undefined) return;
		options.jobs?.kill(job.id);
		render();
	};

	/** 让作业列表的光标始终可见。 */
	const ensureJobVisible = (): void => {
		const rows = Math.max(1, mainAreaHeight() - JOB_ACTION_HEIGHT);
		const row = 2 + jobCursor;
		if (row < pageScrollTop) pageScrollTop = row;
		else if (row >= pageScrollTop + rows) pageScrollTop = row - rows + 1;
	};

	/** 取输入开头的命令名(不含斜杠);不是命令时返回空串。 */
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
				updateFileMenu();
				render();
				return true;
			}
		}
		setInput(inputHistory[historyIndex] ?? "");
		updateCommandMenu();
		updateFileMenu();
		render();
		return true;
	};

	/**
	 * 把一条普通提问交给真实对话。
	 *
	 * 提交与出队都走这里：排队消息出队后与使用者当场提交是同一件事，差别只在谁触发的。
	 */
	const launch = (prompt: string, images: readonly ImageAttachment[] = []): void => {
		const agent = options.agent;
		if (agent === undefined) {
			commandMenu = undefined;
			resetStatusMeta();
			setStatus(AGENT_UNAVAILABLE, "notice");
			render();
			return;
		}
		startRun(prompt, images, (onEvent, signal) => agent.runTurn(prompt, images, onEvent, signal));
	};

	/**
	 * 批准计划：退出 Plan 模式，并把整份计划作为新提示交给模型。
	 *
	 * 只发一句「开始实现」不够稳：压缩或重启后模型可能只记得计划摘要。完整计划随用户消息
	 * 重新进入上下文，实现阶段以它为准。
	 */
	const approvePlan = (): void => {
		const plan = planReview ?? latestPlan;
		if (plan === undefined) {
			closePlanReview();
			render();
			return;
		}

		const agent = options.agent;
		closePlanReview();
		if (agent === undefined) {
			resetStatusMeta();
			setStatus(AGENT_UNAVAILABLE, "notice");
			scheduleStatusClear();
			render();
			return;
		}

		try {
			if (planning()) options.planMode?.select(false);
		} catch (error) {
			resetStatusMeta();
			setStatus(
				`Failed to leave Plan mode: ${describeError(error)}`,
				"error",
			);
			scheduleStatusClear();
			render();
			return;
		}
		setInput("");
		launch(implementationPrompt(plan.text));
	};

	/** 要求修改：关闭审批页，保持或开启 Plan 模式，回到输入框写修改意见。 */
	const revisePlan = (): void => {
		closePlanReview();
		if (!planning()) {
			if (options.planMode === undefined) {
				resetStatusMeta();
				setStatus("Plan mode is unavailable in this session", "notice");
				scheduleStatusClear();
				render();
				return;
			}
			try {
				options.planMode.select(true);
			} catch (error) {
				resetStatusMeta();
				setStatus(
					`Failed to enter Plan mode: ${describeError(error)}`,
					"error",
				);
				scheduleStatusClear();
				render();
				return;
			}
		}

		if (input.length === 0) setInput("Revise the plan: ");
		clearStatus();
		render();
	};

	/** 退出计划：关闭审批页并离开 Plan 模式，计划本身仍可用 /view-plan 回看。 */
	const leavePlan = (): void => {
		const wasPlanning = planning();
		closePlanReview();
		try {
			if (wasPlanning) options.planMode?.select(false);
		} catch (error) {
			resetStatusMeta();
			setStatus(
				`Failed to leave Plan mode: ${describeError(error)}`,
				"error",
			);
			scheduleStatusClear();
			render();
			return;
		}

		clearStatus();
		render();
	};

	/**
	 * 一轮结束后取队首再发一轮。
	 *
	 * 只有正常收尾才续发：被中止说明使用者要停下来，队列留着等他决定，不能替他继续。
	 */
	const drainQueue = (): void => {
		const next = queued.shift();
		if (next === undefined) return;
		launch(next.text, next.images);
	};

	/** 回车发送：把输入交给真实 TurnDriver，事件驱动对话流与状态行。 */
	const submit = (): boolean => {
		if (restoringCheckpoint) {
			// 工作区正在恢复，此时开新回合会让模型看到一半旧、一半新的文件
			setStatus("Restoring checkpoint...", "notice");
			scheduleStatusClear();
			render();
			return false;
		}
		if (imageLoading) {
			// 标记还没落进输入框，此时发送会得到一轮文字与图片对不上的消息
			setStatus("Still reading an image; try again in a moment", "notice");
			scheduleStatusClear();
			render();
			return false;
		}
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
		const command = selected ?? findCommand(message, commands());
		if (message.startsWith("/") && command !== undefined) {
			// 一轮进行中只放行不碰对话的命令；其余要等这一轮结束，但得说清为什么没执行。
			// 补全面板此刻占着状态行的位置，先收起它，提示才看得见
			if (activeTurn !== undefined && !TURN_SAFE_COMMANDS.has(command.name)) {
				commandMenu = undefined;
				commandMenuDismissed = true;
				setStatus(`/${command.name} is unavailable while a turn is running`, "notice");
				render();
				return false;
			}
			// 命令先于受限检查执行：/model 正是用来修复配置对不上的入口
			rememberInput(message);
			executeCommand(command, selected === undefined ? commandArgs(message, command.name) : "");
			return true;
		}

		rememberInput(message);
		const images = imagesInPrompt(message, pendingImages);
		const attachmentError = attachmentSetError(images);
		if (attachmentError !== undefined) {
			setStatus(attachmentError, "warning");
			scheduleStatusClear();
			render();
			return false;
		}
		// 一轮进行中不再丢输入：排进队列，本轮收尾后自动发送
		if (activeTurn !== undefined) {
			clearAttachments();
			commandMenu = undefined;
			setInput("");
			queued.push({ text: message, images });
			render();
			return true;
		}

		if (!ready) {
			// 配置没读成功时不进入对话：保留输入与图片标记，只把原因放到运行时状态行
			commandMenu = undefined;
			resetStatusMeta();
			setStatus(CONFIGURATION_REQUIRED, "notice");
			render();
			return false;
		}

		clearAttachments();
		setInput("");
		launch(message, images);
		return true;
	};

	/**
	 * 菜单面板的公共鼠标交互:悬停改选、滚轮翻动、点击选中并确认。
	 *
	 * 模型、思考等级、会话与命令补全四种面板共用这一套规则,差异全部收在
	 * target 的回调里;新增面板不必再抄一遍交互。返回 true 表示这块数据已被面板消费。
	 */
	const handleMenuMouse = (events: readonly MouseInput[], target: MenuMouseTarget): boolean => {
		for (const event of events) {
			const motion = dragMotion(event.button);
			const index = target.hitItem(event.row);
			if (motion) {
				if (index !== undefined && index !== target.cursor()) {
					target.select(index);
					render();
					return true;
				}
				continue;
			}
			if (event.press && event.button === MOUSE_WHEEL_UP) {
				target.move(-1);
				return true;
			}
			if (event.press && event.button === MOUSE_WHEEL_DOWN) {
				target.move(1);
				return true;
			}
			if (event.press && (event.button & MOUSE_BUTTON_MASK) === 0 && index !== undefined) {
				target.select(index);
				target.confirm();
				return true;
			}
		}
		return false;
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
					`Failed to switch approval: ${describeError(error)}`,
					"error",
				);
				scheduleStatusClear();
			}
			render();
			return;
		}

		if (approvalPrompt !== undefined) {
			// 审批卡是模态的，但只接管自己的动作；上方对话流仍可滚动和双击展开
			const panelWidth = terminalWidth();
			const panelHeight = terminalHeight(stdout);
			const mainHeight = mainAreaHeight();
			const panelTop = Math.max(0, panelHeight - footerHeight());
			let wheelSteps = 0;
			let dragRow: number | undefined;

			for (const event of mouseOf()) {
				const motion = dragMotion(event.button);
				const action =
					event.row === panelTop + 5
						? approvalActionAt(panelWidth, approvalPrompt, event.column - 1)
						: undefined;
				if (event.press && event.button === MOUSE_WHEEL_UP) {
					wheelSteps -= 1;
					continue;
				}
				if (event.press && event.button === MOUSE_WHEEL_DOWN) {
					wheelSteps += 1;
					continue;
				}
				if (motion) {
					if (action !== undefined && action !== approvalSelection) {
						approvalSelection = action;
						render();
					}
					if (draggingScrollbar) dragRow = event.row;
					continue;
				}
				if (!event.press) {
					draggingScrollbar = false;
					continue;
				}
				if ((event.button & MOUSE_BUTTON_MASK) !== 0) continue;
				if (action !== undefined) {
					resolveApproval(action);
					return;
				}
				if (event.column === panelWidth && event.row <= mainHeight && turns.length > 0) {
					draggingScrollbar = true;
					dragRow = event.row;
					continue;
				}
				draggingScrollbar = false;
				if (event.row > mainHeight) continue;

				const now = Date.now();
				const doubleClick =
					lastClick !== undefined &&
					now - lastClick.at <= DOUBLE_CLICK_MS &&
					lastClick.row === event.row &&
					lastClick.column === event.column;
				lastClick = { at: now, row: event.row, column: event.column };
				if (doubleClick && toggleTranscriptAt(event.row, event.column, mainHeight, panelWidth)) {
					return;
				}
			}

			if (wheelSteps !== 0) {
				const limit = maxScroll();
				scrollTop = Math.min(limit, Math.max(0, scrollTop + wheelSteps * WHEEL_STEP));
				follow = scrollTop >= limit;
				render();
				return;
			}
			if (dragRow !== undefined) {
				const limit = maxScroll();
				scrollTop = scrollTopForRow(dragRow, mainHeight, limit);
				follow = scrollTop >= limit;
				render();
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
			if (text === "\x05") {
				if (toggleLastExpandable(turns)) {
					markTranscriptDirty();
					follow = false;
					render();
				}
				return;
			}
			if (text === "\x0f") {
				if (toggleLastToolResult(turns)) {
					markTranscriptDirty();
					follow = false;
					render();
				}
				return;
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

		if (modalMenuOpen()) {
			// 面板只接管选择相关的按键（上下、回车、Tab、Esc）与鼠标；其余按键放行给输入框。
			// 文字一变面板就收掉（见 editInput 处）：面板由命令打开，输入不再是那条命令
			// 面板上边框画在页脚区的第一行，页脚高 N 行时它就是 height-N+1（1 基）
			const panelTop = Math.max(1, terminalHeight(stdout) - footerHeight() + 1);
			// 三种选择面板的鼠标交互是同一套,只有命中与选中后的同步不同
			if (modelMenu !== undefined) {
				const menu = modelMenu;
				if (
					handleMenuMouse(mouseOf(), {
						hitItem: (row) =>
							menuIndexAtRow(row, panelTop, menu.items.length, menu.scrollTop, menu.cursor),
						cursor: () => menu.cursor,
						select: (index) => {
							menu.cursor = index;
							keepMenuCursor();
						},
						move: moveMenu,
						confirm: confirmMenu,
					})
				) {
					return;
				}
			} else if (effortMenu !== undefined) {
				const menu = effortMenu;
				if (
					handleMenuMouse(mouseOf(), {
						hitItem: (row) =>
							menuIndexAtRow(row, panelTop, THINKING_LEVELS.length, menu.scrollTop, menu.cursor),
						cursor: () => menu.cursor,
						// 思考等级只有五档,面板永远装得下,选中后不需要同步滚动窗口
						select: (index) => {
							menu.cursor = index;
						},
						move: moveEffortMenu,
						confirm: confirmEffortMenu,
					})
				) {
					return;
				}
			} else if (sessionMenu !== undefined) {
				const menu = sessionMenu;
				if (
					handleMenuMouse(mouseOf(), {
						hitItem: (row) =>
							menuIndexAtRow(row, panelTop, menu.items.length, menu.scrollTop, menu.cursor),
						cursor: () => menu.cursor,
						select: (index) => {
							menu.cursor = index;
							keepSessionCursor();
						},
						move: moveSessionMenu,
						confirm: confirmSessionMenu,
					})
				) {
					return;
				}
				if (text === "f") {
					forkSelectedSession();
					return;
				}
			}

			// 键盘同样只差回调:上下移动、回车确认、Tab 补全、Esc 收起
			const key = menuKey(text);
			const panel =
				modelMenu !== undefined
					? { move: moveMenu, confirm: confirmMenu, complete: completeModelMenu, cancel: cancelMenu }
					: sessionMenu !== undefined
						? {
								move: moveSessionMenu,
								confirm: confirmSessionMenu,
								complete: completeSessionMenu,
								cancel: cancelSessionMenu,
							}
						: {
								move: moveEffortMenu,
								confirm: confirmEffortMenu,
								complete: completeEffortMenu,
								cancel: cancelEffortMenu,
							};
			if (key === "up" || key === "down") {
				panel.move(key === "up" ? -1 : 1);
				return;
			}
			if (key === "enter") {
				panel.confirm();
				return;
			}
			if (key === "tab") {
				// 最后一级面板没有更深的选择：Tab 只补进输入框，不代替回车执行
				panel.complete();
				return;
			}
			if (key === "escape") {
				panel.cancel();
				return;
			}
			// 其余按键放行：打字的瞬间面板会随输入变化收掉（见下面的编辑处理）
		}

		if (openPage !== undefined) {
			const key = menuKey(text);
			// 计划审批页先处理自己的三个动作，其余按键仍走通用的翻页规则
			if (openPage === "plan") {
				if (text === "a") {
					approvePlan();
					return;
				}
				if (text === "r") {
					revisePlan();
					return;
				}
				if (text === "q") {
					leavePlan();
					return;
				}
			}
			if (openPage === "checkpoints") {
				if (key === "up" || key === "down") {
					if (checkpointList.length > 0) {
						checkpointCursor = Math.min(
							checkpointList.length - 1,
							Math.max(0, checkpointCursor + (key === "up" ? -1 : 1)),
						);
						ensureCheckpointVisible();
						render();
					}
					return;
				}
				if (key === "enter") {
					const entry = checkpointList[checkpointCursor];
					if (entry !== undefined) loadCheckpointPreview(entry);
					return;
				}
				if (key === "escape") {
					closeCheckpointPage();
					render();
					return;
				}
			}
			if (openPage === "checkpoint") {
				if (text === "u") {
					restoreCheckpoint();
					return;
				}
				if (key === "escape") {
					if (checkpointReturnToList) {
						openPage = "checkpoints";
						checkpointPreview = undefined;
						pageScrollTop = 0;
						ensureCheckpointVisible();
						render();
					} else {
						closeCheckpointPage();
						render();
					}
					return;
				}
			}
			if (openPage === "jobs") {
				if (key === "up" || key === "down") {
					const jobs = jobsOf();
					if (jobs.length > 0) {
						jobCursor = Math.min(
							jobs.length - 1,
							Math.max(0, jobCursor + (key === "up" ? -1 : 1)),
						);
						ensureJobVisible();
						render();
					}
					return;
				}
				if (key === "enter") {
					const job = selectedJob();
					if (job !== undefined) openJobDetail(job);
					return;
				}
				if (text === "k") {
					killSelectedJob();
					return;
				}
				if (key === "escape") {
					closeJobPage();
					render();
					return;
				}
			}
			if (openPage === "job") {
				if (text === "k") {
					const job = jobsOf().find((candidate) => candidate.id === jobDetailId);
					if (job !== undefined) {
						options.jobs?.kill(job.id);
						render();
					}
					return;
				}
				if (key === "escape") {
					if (jobReturnToList) {
						openPage = "jobs";
						jobDetailId = undefined;
						pageScrollTop = 0;
						ensureJobVisible();
						render();
					} else {
						closeJobPage();
						render();
					}
					return;
				}
			}
			// 整屏页是模态的：上下键与滚轮翻页，Esc 返回，其它按键忽略
			const actionHeight =
				openPage === "plan"
					? PLAN_ACTION_HEIGHT
					: openPage === "checkpoints" || openPage === "checkpoint"
						? CHECKPOINT_ACTION_HEIGHT
						: openPage === "jobs" || openPage === "job"
							? JOB_ACTION_HEIGHT
							: openPage === "sandbox"
								? SANDBOX_ACTION_HEIGHT
								: 0;
			const rows = Math.max(1, mainAreaHeight() - actionHeight);
			const width = terminalWidth();
			const total = pageLines(openPage, width).length;
			let steps = 0;
			for (const event of mouseOf()) {
				if (event.press && event.button === MOUSE_WHEEL_UP) steps -= 1;
				else if (event.press && event.button === MOUSE_WHEEL_DOWN) steps += 1;
			}
			if (key === "up") steps -= 1;
			if (key === "down") steps += 1;
			const scroll = scrollKey(text);
			if (scroll === "pageUp") steps -= rows;
			if (scroll === "pageDown") steps += rows;

			if (key === "escape") {
				if (openPage === "plan") closePlanReview();
				else openPage = undefined;
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

		const width = terminalWidth();
		const height = terminalHeight(stdout);
		const mainHeight = Math.max(
			0,
			height - footerHeight() - todoPanelHeight() - jobBarHeight(),
		);
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
			const left = (event.button & MOUSE_BUTTON_MASK) === 0;
			const motion = event.button >= 32 && event.button < 64;
			// 低两位是 3 表示没有按键：1003 模式下这类事件只是指针在移动，也就是悬停
			const hover = motion && (event.button & MOUSE_BUTTON_MASK) === 3;

			if (hover) {
				const over = buttonShown && scrollButtonHit(bottomButton, event.row, event.column);
				if (over !== buttonHovered) {
					buttonHovered = over;
					hoverChanged = true;
				}
				continue;
			}

			if (event.press && event.button === MOUSE_WHEEL_UP) {
				wheelSteps -= 1;
			} else if (event.press && event.button === MOUSE_WHEEL_DOWN) {
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

				// 双击思考标题、工具组、任务卡或子代理组，展开或收起
				if (doubleClick && toggleTranscriptAt(event.row, event.column, mainHeight, width)) {
					return;
				}

				// 常驻面板头行:双击收起/展开条目。面板在对话流外面,行号要按自己的位置算
				if (
					doubleClick &&
					currentTodo !== undefined &&
					todoPanelHeight() > 0 &&
					event.row === mainHeight + 1 &&
					event.column < width - 1
				) {
					currentTodo.collapsed = currentTodo.collapsed !== true;
					lastClick = undefined;
					render();
					return;
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
			const menu = commandMenu;
			if (
				handleMenuMouse(mouseOf(), {
					hitItem: (row) =>
						menuIndexAtRow(row, commandPanelTop, menu.items.length, menu.scrollTop, menu.cursor),
					cursor: () => menu.cursor,
					select: (index) => {
						menu.cursor = index;
						menu.scrollTop = keepVisible(menu.scrollTop, menu.cursor, menu.items.length);
					},
					move: moveCommandMenu,
					confirm: () => {
						// 点击即选中并执行，与回车一致：有二级面板的命令点开面板，其余直接执行
						const selected = menu.items[menu.cursor];
						if (selected === undefined) return;
						if (activeTurn !== undefined && !TURN_SAFE_COMMANDS.has(selected.name)) {
							commandMenu = undefined;
							commandMenuDismissed = true;
							setStatus(`/${selected.name} is unavailable while a turn is running`, "notice");
							render();
							return;
						}
						executeCommand(selected);
					},
				})
			) {
				return;
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

		if (fileMenu !== undefined) {
			// 文件补全和命令补全一样不抢输入焦点，只接管选择相关的按键与鼠标
			const menu = fileMenu;
			const filePanelTop = Math.max(1, terminalHeight(stdout) - footerHeight() + 1);
			if (
				handleMenuMouse(mouseOf(), {
					hitItem: (row) =>
						menuIndexAtRow(row, filePanelTop, menu.items.length, menu.scrollTop, menu.cursor),
					cursor: () => menu.cursor,
					select: (index) => {
						menu.cursor = index;
						menu.scrollTop = keepVisible(menu.scrollTop, menu.cursor, menu.items.length);
					},
					move: moveFileMenu,
					confirm: insertFileReference,
				})
			) {
				return;
			}

			const key = menuKey(text);
			if (key === "up" || key === "down") {
				moveFileMenu(key === "up" ? -1 : 1);
				return;
			}
			if (key === "tab" || key === "enter") {
				insertFileReference();
				return;
			}
			if (key === "escape") {
				closeFileMenu(true);
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
		// Ctrl+V / Alt+V 读剪贴板里的图片；终端自己处理的文本粘贴不会走到这里
		const clipboardKey =
			withoutMouse === "\x16" || withoutMouse === "\x1bv" || withoutMouse === "\x1bV";
		if (clipboardKey && !pasting) {
			attachClipboardImage(inputCursor);
			return;
		}
		// 拖入终端只会得到一段路径文本：整段就是一个现有图片时插成正文标记，不填进输入框
		if (commandMenu === undefined && !pasting) {
			const dragged = draggedImagePath(text);
			if (dragged !== undefined) {
				attachImagePath(dragged, inputCursor);
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
					// 队列里的正文已经带着标记，把对应图片数据接回来，删除标记仍能取消那张图
					for (const image of recalled.images) {
						const token = imageMarker(image.name);
						if (!pendingImages.some((item) => item.token === token)) {
							pendingImages.push({ token, image });
						}
					}
					setInput(input.length === 0 ? recalled.text : `${recalled.text}\n${input}`);
					updateCommandMenu();
					updateFileMenu();
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
			fileMenuDismissed = false;
		}
		// 文字一变，选择面板就收掉：面板由命令打开，输入一旦不再是那条命令它就失去意义；
		// 命令补全面板相反，跟着新输入继续过滤
		if (edit.text !== previous && (modalMenuOpen())) {
			modelMenu = undefined;
			effortMenu = undefined;
			sessionMenu = undefined;
		}
		setInput(edit.text, edit.cursor);
		updateCommandMenu();
		updateFileMenu();
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

	const appendJobNote = (job: JobView): void => {
		const elapsed = jobElapsed(job);
		const code =
			job.exitCode !== undefined && job.exitCode !== null ? ` · exit ${job.exitCode}` : "";
		const verb = job.status === "done" ? "finished" : job.status === "killed" ? "killed" : "failed";
		appendCommandTurn("/jobs", [
			{
				kind: job.status === "failed" ? "error" : "info",
				text: `Job ${job.id} ${verb} · ${job.command}${code} · ${elapsed}`,
			},
		]);
	};

	/** 有作业运行时每 500ms 重绘一次，空闲时也更新 Jobs bar 的耗时。 */
	const ensureJobTimer = (): void => {
		if (runningJobs().length === 0) {
			if (jobTimer !== undefined) {
				clearInterval(jobTimer);
				jobTimer = undefined;
			}
			return;
		}
		if (jobTimer !== undefined) return;
		jobTimer = setInterval(() => render(), 500);
	};

	unsubscribeJobs =
		options.jobs?.subscribe((event) => {
			if (event.type === "finished") appendJobNote(event.job);
			ensureJobTimer();
			render();
		}) ?? (() => {});
	ensureJobTimer();

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

