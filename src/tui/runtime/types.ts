import type { AgentEventListener } from "../../agent/events.ts";
import type { ApprovalPrompt } from "../../permission/approval.ts";
import type { ApprovalAnswer } from "../../permission/policy.ts";
import type { TrustAnswer } from "../page/trust.ts";
import type { ImageAttachment, PendingImage } from "../image.ts";
import type { TuiInput, TuiOptions, TuiOutput, PageKind, SessionSwitchResult } from "../options.ts";
import type { CommandMenuState, CommandMenuItem } from "../panel/command-menu.ts";
import type { EffortMenuState } from "../panel/effort-menu.ts";
import type { FileMenuState } from "../panel/file-menu.ts";
import type { ModelMenuState } from "../panel/model-menu.ts";
import type { SessionMenuState } from "../panel/session-menu.ts";
import type {
	SelectionRegion,
	TranscriptLine,
	TranscriptMarkdown,
	TranscriptPlan,
	TranscriptThinking,
	TranscriptTool,
	TranscriptTurn,
	TranscriptView,
} from "../transcript.ts";
import type { TranscriptTodo } from "../view/todo-card.ts";

/** 对话流里的一条真实回合；response 可变，流式文本和工具行持续追加。 */
export interface LiveTurn extends TranscriptTurn {
	response: TranscriptLine[];
}

/** 排队的一条消息：文字与图片一起排队，出队时仍是一次完整输入。 */
interface QueuedPrompt {
	readonly text: string;
	readonly images: readonly ImageAttachment[];
}

/** 一轮正在进行的对话。 */
export interface ActiveTurn {
	readonly turn: LiveTurn;
	readonly controller: AbortController;
	readonly startedAt: number;
	/** 已经完成的文本与工具行 */
	readonly lines: TranscriptLine[];
	/** 当前正在流式写入的 Markdown 文本块；遇到工具、系统行或回合结束时关闭 */
	textBlock: TranscriptMarkdown | undefined;
	/** 当前这段思考是什么时候开始的；没有思考在进行时为空 */
	thinkingStartedAt: number | undefined;
	/** 上一次已经按整秒画出的思考耗时；只在跨秒时重建对话流 */
	thinkingSecond: number;
	/**
	 * 上一次按整秒重建工具耗时的时刻（绝对秒）。
	 *
	 * 记绝对秒而不是某个工具的耗时秒：并行执行时各工具的起点不同，逐条比对会在某些工具
	 * 跨秒时漏掉重建；只要还有工具在跑，每秒重建一次就够了。
	 */
	toolSecond: number;
	/** 当前正在写入的思考区块；结束后仍留在 lines 里供双击展开 */
	thinkingBlock: TranscriptThinking | undefined;
	/** 本轮已经产生的 token 消耗；每次请求回报后累加，压缩请求不计入 */
	tokensUsed: number;
	outcome: "done" | "error" | "aborted";
}

/** 启动时的信任确认；有它时界面挡在对话流前面，作出结论后才继续。 */
export interface TrustPromptState {
	readonly root: string;
	readonly files: readonly string[];
	readonly skillDirectories: readonly string[];
	/** 动作行当前高亮的结论；默认记住信任，回车即放行 */
	selection: TrustAnswer;
	/** 正在记录结论；期间按键忽略，避免重复触发回调 */
	pending: boolean;
}

/**
 * 已稳定回合的渲染缓存。
 *
 * 流式输出时每一帧都会让整份对话流失效，而真正变的只有最后一个回合；不缓存前缀的话，
 * 每 100 毫秒都要把全部历史重新解析一遍 markdown 与折行，长会话下帧率守不住。
 * 回合对象是整体替换的，引用相等就说明没变，因此判定不需要深比较。
 */
export interface TranscriptPrefix {
	/** 缓存建立时那份 turns 的引用，用来逐项核对前缀没被换掉 */
	readonly turns: readonly TranscriptTurn[];
	/** 前多少个回合已经被 view 覆盖 */
	readonly count: number;
	readonly width: number;
	readonly notice: string | undefined;
	readonly view: TranscriptView;
}

/**
 * 界面运行期的全部可变状态。
 *
 * 字段按所属的交互域分段；`layout` 只负责创建它并把装配好的依赖交给各域模块，
 * 模块之间不互相直接调用，需要协作时通过这里的状态与回调推进。
 */
export interface TuiState {
	// —— 终端与输入 ——
	readonly stdin: TuiInput;
	readonly stdout: TuiOutput;
	ready: boolean;
	activeWarning: string | undefined;
	readonly sandboxNotice: string | undefined;
	builtinCommands: readonly CommandMenuItem[];
	input: string;
	inputCursor: number;
	/** 当前输入里的图片标记与数据；发送、清空或切会话时清掉。 */
	pendingImages: PendingImage[];
	/** 读图期间不接受第二张，避免标记插入顺序与提示错乱。 */
	imageLoading: boolean;
	/** 清空图片时递增：上一张图晚到的读取结果不再落进新输入。 */
	attachmentEpoch: number;
	/** 排队中的消息，按发送顺序。 */
	readonly queued: QueuedPrompt[];
	/** 下一次中止是否要把队首立刻发出去。 */
	sendQueuedAfterAbort: boolean;
	readonly inputHistory: string[];
	historyIndex: number;
	historyDraft: string;
	/** bracketed paste 可能跨多个数据块，记住是否还在粘贴中。 */
	pasting: boolean;
	/** 上一块末尾未完成的转义序列；与下一块拼接后再解析，避免标记被分块切断。 */
	inputTail: string;
	inputTailTimer: ReturnType<typeof setTimeout> | undefined;
	/** 粘贴态的超时兜底；每次收到新数据重新计时。 */
	pastingTimer: ReturnType<typeof setTimeout> | undefined;

	// —— 对话流 ——
	readonly turns: LiveTurn[];
	/** 当前任务表:最近一次未收尾的 todo 调用卡片,常驻面板的数据源。 */
	currentTodo: TranscriptTodo | undefined;
	/** 有历史或输入过内容就显示对话流。 */
	hasInput: boolean;
	/** 一轮进行中执行的命令，回复暂存在这里，等这一轮结束再落进对话流。 */
	readonly pendingCommandTurns: LiveTurn[];
	/** 首次绘制时把已有历史滚到底部。 */
	initialScroll: boolean;
	/** 输入框是否持有焦点；点击对话流会失焦，窗口焦点上报也会同步它。 */
	focused: boolean;
	/** 终端窗口是否持有操作系统焦点；只用于通知，不参与输入框边框与光标 */
	windowFocused: boolean;
	/** 对话流从顶部滚过的行数。 */
	scrollTop: number;
	/** 上一次左键按下的位置与时间，用于识别双击。 */
	lastClick: { at: number; row: number; column: number } | undefined;
	/** 鼠标拖选中的文本区域；松开时复制并清空。 */
	selection: SelectionRegion | undefined;
	/** 是否跟随新内容滚到底部。 */
	follow: boolean;
	/** 对话流构建缓存：同一内容只换行一次，测量、绘制与命中共用。 */
	transcriptView: TranscriptView | undefined;
	transcriptViewWidth: number;
	transcriptViewNotice: string | undefined;
	transcriptDirty: boolean;
	/** 已经写完的那几个回合的渲染结果；流式输出时只重排最后一个回合。 */
	transcriptPrefix: TranscriptPrefix | undefined;
	/** 是否正按住滚动条拖动。 */
	draggingScrollbar: boolean;
	/** 当前帧内容是否超出终端高度；超出时鼠标命中不可靠，先停用鼠标交互。 */
	layoutOverflow: boolean;
	/** 指针是否停在置底按钮上；只影响按钮颜色。 */
	buttonHovered: boolean;
	decoder: InstanceType<typeof import("node:string_decoder").StringDecoder>;

	// —— 状态行 ——
	/** 当前运行时状态；为空表示空闲。 */
	statusText: string | undefined;
	/** 运行状态的色调：重试、失败与阻断提示各用一种，别跟「正在进行」混成一样。 */
	statusTone: "warning" | "error" | "notice" | undefined;
	/** 当前阶段开始的时刻；运行中的阶段耗时由渲染按它现算。 */
	statusPhaseStartedAt: number;
	/** 回合结束时的定格耗时；运行中不为渲染提供数据，由渲染按 active.startedAt 现算。 */
	statusElapsedMs: number;
	/** 回合结束时的定格用量；运行中由渲染按 active.tokensUsed 现算。 */
	statusTokens: number;
	/** 复制成功后的短暂提示：优先占用 token 位置，超时后回显 token 数 */
	copyNotice: string | undefined;
	copyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	spinnerFrame: number;
	sweepPhase: number;

	// —— 运行与审批 ——
	activeTurn: ActiveTurn | undefined;
	/** 只读审查正在跑；期间拒绝新输入与换会话，Ctrl+C 可中止 */
	reviewing: boolean;
	reviewAbort: AbortController | undefined;
	/** 启动信任确认；非空时界面只画这一页，不接受对话输入 */
	trustPrompt: TrustPromptState | undefined;
	/** 信任页正文滚动位置；文件清单很长时不至于把说明整段截掉 */
	trustScrollTop: number;
	approvalPrompt: ApprovalPrompt | undefined;
	/** 界面上这份审批请求的标识；交回结论时带上，防止回答落到另一个请求上 */
	approvalPromptId: number | undefined;
	/** 动作行当前高亮的选项；默认允许一次，直接回车就是放行 */
	approvalSelection: ApprovalAnswer;
	/** 审批详情是否展开；每次出现新的审批请求时收起 */
	approvalExpanded: boolean;
	/** 审批详情滚动到第几行（已按宽度折行） */
	approvalScrollTop: number;

	// —— 面板 ——
	modelMenu: ModelMenuState | undefined;
	effortMenu: EffortMenuState | undefined;
	sessionMenu: SessionMenuState | undefined;
	commandMenu: CommandMenuState | undefined;
	/** 使用者用 Esc 主动关掉补全面板之后，输入没变就不再自动弹出。 */
	commandMenuDismissed: boolean;
	fileMenu: FileMenuState | undefined;
	/** 与命令补全同一套规则：Esc 主动收起后，输入不变就不再弹回来。 */
	fileMenuDismissed: boolean;
	/** 当前 @ 片段对应的文件索引；同一次补全期间复用，换片段或关面板时丢弃。 */
	fileFiles: readonly string[] | undefined;
	fileIndexStart: number | undefined;

	// —— 整屏页 ——
	/** 占据主区域的整屏页；打开期间视口只跟着它自己的滚动。 */
	openPage: PageKind | undefined;
	/** 整屏页从顶部滚过的行数。 */
	pageScrollTop: number;
	/** Ctrl+G 打开的整屏长内容；关闭后保留到下一次打开覆盖 */
	viewer: ViewerContent | undefined;
	/** Ctrl+G 优先查看的工具：使用者最后点选或展开的那一行 */
	viewerTool: TranscriptTool | undefined;
	/** 当前正在审批页里展示的计划；为空时计划页没有内容。 */
	planReview: TranscriptPlan | undefined;
	/** 最近一份计划；计划卡与审批页都从这里打开。 */
	latestPlan: TranscriptPlan | undefined;
	/** 本轮刚提交、等回合结束后自动打开审批页的计划。 */
	pendingPlan: TranscriptPlan | undefined;
	/** 恢复期间拒绝新输入，避免在工作区变化时开始下一轮。 */
	restoringCheckpoint: boolean;
	/** /mcps 页的选中项；重连与健康检查作用在它上面 */
	mcpCursor: number;
	/** /mcps 页上的操作反馈：整屏页没有状态行，结果必须画在页面里 */
	mcpStatus: string | undefined;
	/** 排好版的页面内容；宽度不变就复用，滚动与重绘都不必重排。 */
	pageCache:
		| { readonly kind: PageKind; readonly width: number; readonly lines: readonly string[] }
		| undefined;

	// —— 定时器与生命周期 ——
	spinnerTimer: ReturnType<typeof setInterval> | undefined;
	/** 只在有作业运行时启动：让 Jobs bar 的耗时跟着当前时间走。 */
	jobTimer: ReturnType<typeof setInterval> | undefined;
	unsubscribeJobs: () => void;
	statusClearTimer: ReturnType<typeof setTimeout> | undefined;
	exitArmed: boolean;
	exitTimer: ReturnType<typeof setTimeout> | undefined;
	finished: boolean;
	finish: () => void;
}

/** 整屏查看的长内容；标题用于页头，正文由查看页按宽度重排。 */
export interface ViewerContent {
	readonly title: string;
	readonly text: string;
}

/** 装配层提供给各域模块的能力：状态读写、几何、页面切换与跨域动作。 */
export interface TuiHost {
	readonly options: TuiOptions;
	readonly state: TuiState;
	render(): void;
	setInput(value: string, cursor?: number): void;
	setStatus(text: string, tone?: "warning" | "error" | "notice"): void;
	clearStatus(): void;
	resetStatusMeta(): void;
	scheduleStatusClear(): void;
	/** 复制一段文本并在状态行报告结果 */
	copyText(text: string): void;
	markTranscriptDirty(): void;
	showPage(kind: PageKind): void;
	/** 打开最近一块长内容的整屏查看页；没有可查看内容时只给提示 */
	openViewer(): void;
	pageLines(kind: PageKind, width: number): readonly string[];
	terminalWidth(): number;
	terminalHeight(): number;
	mainAreaHeight(): number;
	footerHeight(): number;
	approvalPanelTop(): number;
	inputTopRow(mainHeight: number): number;
	todoPanelHeight(): number;
	jobBarHeight(): number;
	commands(): readonly CommandMenuItem[];
	noticeText(): string | undefined;
	currentTranscript(width: number): TranscriptView;
	maxScroll(): number;
	planning(): boolean;
	menuOpen(): boolean;
	modalMenuOpen(): boolean;
	compactFooter(): boolean;
	scrollTopForRow(row: number, limit: number): number;
	startRun(
		prompt: string,
		images: readonly ImageAttachment[],
		run: (onEvent: AgentEventListener, signal: AbortSignal) => Promise<void>,
	): void;
	launch(prompt: string, images?: readonly ImageAttachment[]): void;
	drainQueue(): void;
	appendLine(active: ActiveTurn, line: TranscriptLine): void;
	syncTurn(active: ActiveTurn): void;
	syncTurnFull(active: ActiveTurn): void;
	closeThinking(active: ActiveTurn): void;
	appendCommandTurn(prompt: string, response: readonly TranscriptLine[]): void;
	openPlanReview(plan: TranscriptPlan): void;
	closePlanReview(): void;
	clearAttachments(): void;
	syncApprovalPrompt(): boolean;
	resolveApproval(answer: ApprovalAnswer): void;
	/** 交回信任结论；记住与仅本次的区别由宿主决定要不要落盘 */
	resolveTrust(answer: TrustAnswer): void;
	moveApprovalSelection(delta: number): void;
	notify(message: string): void;
	runUndo(): void;
	toggleTranscriptAt(row: number, column: number, mainHeight: number, width: number): boolean;
	switchSession(id: string, action?: "select" | "fork"): void;
	sessionTitle(title: string | undefined): string;
	/** /mcps 页：移动选中项、重连选中的 server、检查全部连接 */
	moveMcpCursor(delta: number): void;
	reconnectMcp(): void;
	healthCheckMcp(): void;
	applySession(result: SessionSwitchResult): void;
	rememberInput(value: string): void;
	recallHistory(delta: -1 | 1): boolean;
	insertImageMarker(image: ImageAttachment, at: number): void;
	attachImagePath(path: string, at?: number): void;
	attachClipboardImage(at?: number): void;
	readAndInsertImage(read: () => Promise<ImageAttachment>, status: string, at: number): void;
	draggedImagePath(chunk: string): string | undefined;
	imagesInInput(): readonly ImageAttachment[];
	approvePlan(): void;
	revisePlan(): void;
	leavePlan(): void;
	executeUndo(): void;
	startJobTimer(): void;
	closeFileMenu(dismissed?: boolean): void;
	updateCommandMenu(): void;
	updateFileMenu(): void;
	insertFileReference(): void;
	/** 五种选择面板互斥，下面这组方法作用于当前打开的那一个。 */
	openModelMenu(): void;
	openEffortMenu(): void;
	openSessionMenu(): void;
	moveMenu(delta: number): void;
	confirmMenu(): void;
	completeMenu(): void;
	cancelMenu(): void;
	forkSelectedSession(): void;
	/** 切到当前会话的另一个分支末尾 */
	switchBranch(id: string): void;
	/** 回退到某条消息之前，并把原文放回输入框 */
	rewindTo(id: string): void;
	executeCommand(command: CommandMenuItem, args?: string): void;
	submit(): boolean;
	/** 收尾退出整个界面；用于拒绝信任这类「不再继续」的结论。 */
	exit(): void;
}
