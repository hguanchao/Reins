import type { AgentEventListener } from "../agent/events.ts";
import type {
	CheckpointEntry,
	CheckpointPreview,
	CheckpointRestoreResult,
} from "../checkpoint/service.ts";
import type { ApprovalMode, NotifyMode, ThinkingLevel } from "../config/file.ts";
import type { ApprovalBroker } from "../permission/approval.ts";
import type { SandboxInfo } from "../sandbox/setup.ts";
import type { CommandMenuItem } from "./panel/command-menu.ts";
import type { FileSource } from "./panel/file-menu.ts";
import type { FooterInfo } from "./view/footer.ts";
import type { ImageAttachment, ImageSource } from "./image.ts";
import type { JobEvent, JobView } from "./page/job.ts";
import type { ModelMenuItem } from "./panel/model-menu.ts";
import type { PageEntry, SkillPageEntry } from "./page/frame.ts";
import type { SessionMenuItem } from "./panel/session-menu.ts";
import type { TranscriptPlan, TranscriptTurn } from "./transcript.ts";
import type { TranscriptTodo } from "./view/todo-card.ts";

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

interface ModelSwitchResult {
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
	/** 新会话最后一张任务表；没有时常驻面板随之收起 */
	readonly todo?: TranscriptTodo;
	/** 新会话最近一份计划；没有时 /view-plan 提示还没有计划 */
	readonly plan?: TranscriptPlan;
	readonly warnings: readonly string[];
	/** 分叉时说明来源与复制量；普通切换没有这一项 */
	readonly fork?: {
		readonly sourceId: string;
		readonly copied: number;
	};
}

export interface SessionMenuSource {
	/** 当前项目的全部会话，按最近活动从新到旧；每次打开菜单时重新取 */
	readonly list: () => readonly SessionMenuItem[];
	/** 切换会话；失败时抛错，由界面显示原因 */
	readonly select: (id: string) => SessionSwitchResult;
	/** 从选中会话的当前末尾分叉并切过去；不提供时 /fork 与菜单里的 f 不可用 */
	readonly fork?: (id: string) => SessionSwitchResult;
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

/**
 * Plan 模式的数据来源。
 *
 * 与审批模式正交：宿主只负责只读闸门，界面负责命令、徽标与审批页。切换只在本次运行内
 * 有效，不写配置文件。
 */
export interface PlanModeSource {
	/** 当前是否处于 Plan 模式；徽标逐帧读取 */
	readonly current: () => boolean;
	/** 开启或关闭 Plan 模式；失败时抛错，由界面显示原因 */
	readonly select: (enabled: boolean) => void;
}

/**
 * 检查点与撤销的数据来源。
 *
 * 列表是同步的（索引已在内存），预览与恢复会跑 git，所以返回 Promise。界面只负责
 * 展示与确认，真正的快照与恢复由宿主服务完成。
 */
export interface CheckpointSource {
	readonly available: () => boolean;
	readonly error: () => string | undefined;
	readonly list: () => readonly CheckpointEntry[];
	readonly latestUndoable: () => Promise<CheckpointPreview | undefined>;
	readonly preview: (id: string) => Promise<CheckpointPreview>;
	readonly restore: (id: string) => Promise<CheckpointRestoreResult>;
}

/** 后台作业的界面数据源；由宿主的 JobManager 提供。 */
export interface JobSource {
	readonly list: () => readonly JobView[];
	readonly output: (id: string) => string;
	readonly kill: (id: string) => unknown;
	readonly subscribe: (listener: (event: JobEvent) => void) => () => void;
	readonly shutdown: () => void;
}

/** 插件与宿主注册的斜杠命令；由装配处桥接到 PluginHost。 */
interface PluginCommandSource {
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
		images: readonly ImageAttachment[],
		onEvent: AgentEventListener,
		signal: AbortSignal,
	) => Promise<void>;
	/** 立即压缩上下文；不提供时 /compact 不可用。事件与普通对话共用一套。 */
	readonly compact?: (onEvent: AgentEventListener, signal: AbortSignal) => Promise<void>;
	/** 会话记下新的用量或压缩后刷新页脚统计。 */
	readonly refreshInfo: () => void;
}

/** 整屏页的内容；帮助、技能、MCP、沙箱、计划、检查点、后台作业与长内容查看共用同一套滚动。 */
export type PageKind =
	| "help"
	| "skills"
	| "mcps"
	| "sandbox"
	| "plan"
	| "checkpoints"
	| "checkpoint"
	| "jobs"
	| "job"
	| "viewer";

/**
 * `/skills` 页的内容。
 *
 * 清单按需读取：每次打开页面都重扫一遍，改完 SKILL.md 重新打开就能看到。提示词那一份也是
 * 每轮重读的，两者取的是同一个来源，不会一个看得到、另一个看不到。
 */
interface SkillsPageSource {
	readonly list: () => readonly SkillPageEntry[];
	/** 实际扫过的目录，脚注逐条列出；按需读取，取得信任后要多出项目目录 */
	readonly directories: () => readonly string[];
}

/**
 * 启动时的信任确认。
 *
 * 只在「这个工作区带有需要信任的东西、而使用者还没给过结论」时提供；没有它时界面直接进入
 * 对话流。询问发生在主界面里而不是启动前的独立页面，因为界面已经装配好，项目技能与规则
 * 本来就是每轮重读的，翻转让下一轮立即生效。
 */
export interface TrustPromptSource {
	readonly root: string;
	/** 需要信任才会读取的文件 */
	readonly files: readonly string[];
	/** 需要信任才会读取的技能目录 */
	readonly skillDirectories: readonly string[];
	/** 记录授予并返回要给使用者看的说明；remember 为 false 时只对本次运行生效。失败时抛错，由界面显示原因 */
	readonly accept: (remember: boolean) => Promise<readonly string[]>;
}

/**
 * `/sandbox` 页的数据来源。
 *
 * warning 与配置警告分开保存：配置警告会在 /model 修复后消失，而平台缺少命令隔离这件事
 * 不会因为换模型而改变，启动说明要一直留到本次界面退出。
 */
interface SandboxPageSource {
	readonly info: SandboxInfo;
	readonly warning?: string;
}

/** 文本剪贴板；由装配处提供，界面不直接碰平台命令。 */
export interface ClipboardSource {
	/** 写入系统剪贴板；成功返回 true，失败时由界面退到 OSC 52 */
	copy(text: string): boolean;
}

export interface TuiOptions {
	readonly version: string;
	/** 输入框下方常驻信息：项目、分支、模型、思考强度、上下文与缓存命中率 */
	readonly info: FooterInfo | (() => FooterInfo);
	/** 配置有问题时在主区域显示的一行警告；配置正常时不传 */
	readonly warning?: string;
	/** 沙箱模式与平台限制；不提供时 /sandbox 不可用 */
	readonly sandbox?: SandboxPageSource;
	/** 图片读取；不提供时剪贴板、拖入与 @ 选图片都不可用 */
	readonly images?: ImageSource;
	/** 文本剪贴板写入；不提供时拖选复制退到终端 OSC 52 */
	readonly clipboard?: ClipboardSource;
	/** 当前模型是否声明了图片输入；没有声明时附加图片给出提示 */
	readonly imagesSupported?: () => boolean;
	/** @ 文件补全的数据来源；不提供时 @ 按普通文本处理 */
	readonly files?: FileSource;
	/** 配置不可用时为 false：界面照常显示，但不接受提交 */
	readonly ready?: boolean;
	/** 工作区是否已取得信任；只在还没结论、且有需要信任的内容时提供 */
	readonly trustPrompt?: TrustPromptSource;
	/** 真实对话入口；不提供时无法提交普通提示 */
	readonly agent?: AgentRuntime;
	/** 工具审批桥接；不提供时不会弹出审批面板 */
	readonly approval?: ApprovalBroker;
	/** 审批模式的数据来源；不提供时 Shift+Tab 无效、页脚也不显示徽标 */
	readonly approvalMode?: ApprovalModeSource;
	/** Plan 模式的数据来源；不提供时 /plan 不可用、页脚也不显示 PLAN */
	readonly planMode?: PlanModeSource;
	/** 检查点与撤销；不提供时 /undo 与 /checkpoints 不可用 */
	readonly checkpoints?: CheckpointSource;
	/** 后台作业；不提供时 /jobs 不可用，bash 的 background 也会被拒绝 */
	readonly jobs?: JobSource;
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
	/** 历史里最后一张任务表；续聊时让常驻面板立即有内容 */
	readonly historyTodo?: TranscriptTodo;
	/** 历史里最近一份计划；续聊时 /view-plan 可以立即打开 */
	readonly historyPlan?: TranscriptPlan;
	/** 工作根：用来判断命令开头的工作根 cd 是否多余，省略时原样显示 */
	readonly workspaceRoot?: string;
	readonly stdin?: TuiInput;
	readonly stdout?: TuiOutput;
}
