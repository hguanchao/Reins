import type { AgentEventListener } from "../../agent/events.ts";
import type { CheckpointEntry, CheckpointPreview } from "../../checkpoint/service.ts";
import type { ApprovalPrompt } from "../../permission/approval.ts";
import type { ApprovalAnswer } from "../../permission/policy.ts";
import type { ImageAttachment, PendingImage } from "../image.ts";
import type { JobView } from "../page/job.ts";
import type { TuiInput, TuiOptions, TuiOutput, PageKind, SessionSwitchResult } from "../options.ts";
import type { CommandMenuState, CommandMenuItem } from "../panel/command-menu.ts";
import type { EffortMenuState } from "../panel/effort-menu.ts";
import type { FileMenuState } from "../panel/file-menu.ts";
import type { ModelMenuState } from "../panel/model-menu.ts";
import type { SessionMenuState } from "../panel/session-menu.ts";
import type {
	TranscriptLine,
	TranscriptMarkdown,
	TranscriptPlan,
	TranscriptThinking,
	TranscriptTurn,
	TranscriptView,
} from "../transcript.ts";
import type { TranscriptTodo } from "../view/todo-card.ts";

/** 对话流里的一条真实回合；response 可变，流式文本和工具行持续追加。 */
export interface LiveTurn extends TranscriptTurn {
	response: TranscriptLine[];
}

/** 排队的一条消息：文字与图片一起排队，出队时仍是一次完整输入。 */
export interface QueuedPrompt {
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
	/** 当前正在写入的思考区块；结束后仍留在 lines 里供双击展开 */
	thinkingBlock: TranscriptThinking | undefined;
	/** 本轮已经产生的 token 消耗；每次请求回报后累加，压缩请求不计入 */
	tokensUsed: number;
	outcome: "done" | "error" | "aborted";
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
	/** 终端窗口是否有焦点；界面启动时默认有焦点。 */
	focused: boolean;
	/** 对话流从顶部滚过的行数。 */
	scrollTop: number;
	/** 上一次左键按下的位置与时间，用于识别双击。 */
	lastClick: { at: number; row: number; column: number } | undefined;
	/** 是否跟随新内容滚到底部。 */
	follow: boolean;
	/** 对话流构建缓存：同一内容只换行一次，测量、绘制与命中共用。 */
	transcriptView: TranscriptView | undefined;
	transcriptViewWidth: number;
	transcriptViewNotice: string | undefined;
	transcriptDirty: boolean;
	/** 是否正按住滚动条拖动。 */
	draggingScrollbar: boolean;
	/** 指针是否停在置底按钮上；只影响按钮颜色。 */
	buttonHovered: boolean;
	decoder: InstanceType<typeof import("node:string_decoder").StringDecoder>;

	// —— 状态行 ——
	/** 当前运行时状态；为空表示空闲。 */
	statusText: string | undefined;
	/** 运行状态的色调：重试、失败与阻断提示各用一种，别跟「正在进行」混成一样。 */
	statusTone: "warning" | "error" | "notice" | undefined;
	statusPhaseMs: number;
	statusElapsedMs: number;
	statusTokens: number;
	statusPhaseStartedAt: number;
	spinnerFrame: number;
	sweepPhase: number;

	// —— 运行与审批 ——
	activeTurn: ActiveTurn | undefined;
	approvalPrompt: ApprovalPrompt | undefined;
	/** 动作行当前高亮的选项；默认允许一次，直接回车就是放行 */
	approvalSelection: ApprovalAnswer;

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
	/** 当前正在审批页里展示的计划；为空时计划页没有内容。 */
	planReview: TranscriptPlan | undefined;
	/** 最近一份计划；/view-plan 与计划卡都从这里打开。 */
	latestPlan: TranscriptPlan | undefined;
	/** 本轮刚提交、等回合结束后自动打开审批页的计划。 */
	pendingPlan: TranscriptPlan | undefined;
	/** 检查点列表的数据快照；打开页面时取一次，翻动选择不重新扫索引。 */
	checkpointList: readonly CheckpointEntry[];
	checkpointCursor: number;
	/** 当前确认页要恢复的检查点；为空时确认页显示空态。 */
	checkpointPreview: CheckpointPreview | undefined;
	/** 确认页取消后回到列表，而不是直接回对话流。 */
	checkpointReturnToList: boolean;
	/** 防止连续 Enter 同时发起多个预览请求。 */
	checkpointLoading: boolean;
	/** 恢复期间拒绝新输入，避免在工作区变化时开始下一轮。 */
	restoringCheckpoint: boolean;
	/** 后台作业页的光标与当前输出页。 */
	jobCursor: number;
	jobDetailId: string | undefined;
	/** 作业页与检查点页一样把动作条固定在底部。 */
	jobReturnToList: boolean;
	/** 排好版的页面内容；宽度不变就复用，滚动与重绘都不必重排。 */
	pageCache:
		| { readonly kind: PageKind; readonly width: number; readonly lines: readonly string[] }
		| undefined;

	// —— 定时器与生命周期 ——
	spinnerTimer: ReturnType<typeof setInterval> | undefined;
	/** 只在有作业运行时启动：空闲回合也要更新 Jobs bar 的耗时。 */
	jobTimer: ReturnType<typeof setInterval> | undefined;
	unsubscribeJobs: () => void;
	statusClearTimer: ReturnType<typeof setTimeout> | undefined;
	exitArmed: boolean;
	exitTimer: ReturnType<typeof setTimeout> | undefined;
	finished: boolean;
	finish: () => void;
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
	markTranscriptDirty(): void;
	showPage(kind: PageKind): void;
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
	closeCheckpointPage(): void;
	closeJobPage(): void;
	clearAttachments(): void;
	syncApprovalPrompt(): boolean;
	resolveApproval(answer: ApprovalAnswer): void;
	moveApprovalSelection(delta: number): void;
	notify(message: string): void;
	runUndo(): void;
	toggleTranscriptAt(row: number, column: number, mainHeight: number, width: number): boolean;
	switchSession(id: string, action?: "select" | "fork"): void;
	sessionTitle(title: string | undefined): string;
	jobsOf(): readonly JobView[];
	selectedJob(): JobView | undefined;
	ensureCheckpointVisible(): void;
	ensureJobVisible(): void;
	openJobDetail(job: JobView): void;
	killSelectedJob(): void;
	openJobsPage(): void;
	openCheckpointList(): void;
	restoreCheckpoint(): void;
	loadCheckpointPreview(entry: CheckpointEntry): void;
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
	openModelMenu(): void;
	moveMenu(delta: number): void;
	confirmMenu(): void;
	completeModelMenu(): void;
	cancelMenu(): void;
	openEffortMenu(): void;
	moveEffortMenu(delta: number): void;
	confirmEffortMenu(): void;
	completeEffortMenu(): void;
	cancelEffortMenu(): void;
	openSessionMenu(): void;
	moveSessionMenu(delta: number): void;
	confirmSessionMenu(): void;
	completeSessionMenu(): void;
	cancelSessionMenu(): void;
	forkSelectedSession(): void;
	moveCommandMenu(delta: number): void;
	moveFileMenu(delta: number): void;
	executeCommand(command: CommandMenuItem, args?: string): void;
	submit(): boolean;
}
