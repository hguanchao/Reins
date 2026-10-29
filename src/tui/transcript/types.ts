import type { ToolGroupKind } from "../../tools/describe.ts";
import type { ResultDetailKind } from "../../tools/result/detail.ts";
import type { TranscriptTodo } from "../view/todo-card.ts";

/** 子代理的一次运行的终态:组清单与单个调用行都从这里渲染。 */
export interface SubagentRunView {
	/** 派发时的任务描述,清单行的正文位 */
	readonly task: string;
	/** running 之外都是终态;结果到达与回合冻结都会改写它,因此可变 */
	status: "running" | "done" | "failed";
	/** 总耗时;终态定格,运行中由界面按 startedAt 每帧重算 */
	durationMs?: number;
	/** 本次委派的请求步数;结果到达时落定 */
	steps?: number;
	/** 本次委派消耗的 token 总量;结果到达时落定 */
	totalTokens?: number;
	/** 完整失败原因;清单行只显示任务名,双击失败行展开看这里 */
	failure?: string;
	/** 失败行是否已展开;双击切换 */
	expanded?: boolean;
}

/**
 * 同一回合内多个子代理调用的组。
 *
 * 组头恒为 ›(展开 ◈),计数段按 running→done→failed 顺序实时翻新;清单用任务卡片的
 * 四态符号语言,纯展示不可再展开——子代理的过程细节不进主对话流。
 */
export interface TranscriptSubagentGroup {
	readonly kind: "subagentGroup";
	readonly members: (SubagentRunView & { readonly callId: string })[];
	/** 组的第一个子代理的派发时刻;运行中耗时由此起算 */
	readonly startedAt: number;
	/** 组的总耗时;全部结束时定格 */
	durationMs?: number;
	/** 组内各子代理的 token 合计;全部结束时定格 */
	totalTokens?: number;
	expanded: boolean;
}

export interface TranscriptTurn {
	readonly prompt: string;
	readonly response: readonly TranscriptLine[];
}

/**
 * 模型提交的一份计划。
 *
 * 对话流里只画标题行，完整 Markdown 留在对象里供审批页使用。计划作为工具参数进入会话，
 * 历史回放时能从同一份调用重建，不需要额外的文件。
 */
export interface TranscriptPlan {
	readonly kind: "plan";
	readonly text: string;
}

/** 对话流里的一行：字符串就是正文，对象形式用于需要区别样式或折叠的行。 */
export type TranscriptLine =
	| string
	| TranscriptNote
	| TranscriptThinking
	| TranscriptTool
	| TranscriptToolGroup
	| TranscriptSubagentGroup
	| TranscriptTodo
	| TranscriptPlan
	| TranscriptMarkdown;

/** 运行中的子代理清单行：渲染期按当前帧重建转圈与扫光。 */
export interface LiveSubagentLine {
	readonly indent: string;
	readonly label: string;
	readonly summary: string;
}

/**
 * 模型回复里的 Markdown 文本块。
 *
 * 流式增量直接追加到 text；渲染时才排版，因此代码围栏、列表这类跨行结构在流式过程中
 * 也能按当前完整内容正确解析。普通字符串仍然按纯文本渲染，压缩提示、插件输出不受影响。
 */
export interface TranscriptMarkdown {
	readonly kind: "markdown";
	text: string;
}

/**
 * 需要与正文区分开的一行。
 *
 * error 与 warning 是要让人看见的问题；info 是中性的过程说明（比如使用者主动停下），
 * 用弱化色，不该按错误对待。
 */
export interface TranscriptNote {
	readonly text: string;
	readonly kind: "error" | "warning" | "info";
}

/**
 * 工具调用行。
 *
 * name 与 detail 已经由工具描述模块转成给人看的文字；渲染只负责排版。detail 是折叠态看到
 * 的核心命令，fullDetail 是完整命令，双击展开时替换它。失败时 detail 是失败原因，整行用
 * 错误色并带上耗时。
 */
export interface TranscriptTool {
	readonly kind: "tool";
	readonly name: string;
	readonly detail: string;
	/** 展开后的详情；可含换行。工具结束后才生成时也允许写入 */
	fullDetail?: string;
	/** 详情类型：文件内容用行号样式，diff 按增删着色 */
	detailKind?: ResultDetailKind;
	/** 折叠路径的 file:// 链接；终端支持 OSC 8 时会显示为可点击的链接 */
	readonly linkTarget?: string;
	/** 是否在对话流里展开完整参数 */
	detailExpanded?: boolean;
	/** 工具结束后的结果指标，显示在折叠行末尾 */
	metric?: string;
	isError?: boolean;
	durationMs?: number;
	/**
	 * 运行中的计时起点。
	 *
	 * 结束后的耗时以 durationMs 为准；这个字段只在结果还没回来时参与显示，由视图按整秒
	 * 现算，所以不必在结束时清理。历史回填的行没有起点，也不会显示运行态。
	 */
	startedAt?: number;
	/** 工具调用 id，用于把成功结果挂回对应行 */
	readonly callId?: string;
	/** 工具分组类型：只读探索与命令在运行期成组；写操作与失败行没有 */
	readonly group?: ToolGroupKind;
	/** 成功结果全文；展开时显示 */
	result?: string;
	/** 是否在对话流里展开结果 */
	resultExpanded?: boolean;
}

/**
 * 连续同类工具调用的组合。
 *
 * 只读探索组运行时展开显示成员，回合结束折叠成一行组头；命令组只在回合结束时由够数的
 * 连续命令塌成，收起态。双击组头切换。成员保留完整工具行，展开时不丢信息。
 */
export interface TranscriptToolGroup {
	readonly kind: "toolGroup";
	readonly members: TranscriptTool[];
	expanded: boolean;
}

/**
 * 思考区块。
 *
 * 正文完整保留在内存里：运行时默认只显示最后五行，结束后默认只显示标题；双击标题切换
 * 全文。区块对象在对话流里是可变的，流式增量直接写进 body/partial。运行中的标题耗时
 * 由视图按 startedAt 现算；结束后 header 已经定格，startedAt 不再参与显示。
 */
export interface TranscriptThinking {
	readonly kind: "thinkingBlock";
	header: string;
	/** 运行中标题的计时起点 */
	readonly startedAt?: number;
	readonly body: string[];
	partial: string;
	running: boolean;
	expanded: boolean;
}

export interface PromptRange {
	/** 提示块第一行在 transcript 里的下标 */
	readonly start: number;
	/** 提示块正文行数，1 到 3 */
	readonly height: number;
	/** 提示块之后的 gap 与回复内容的起点 */
	readonly responseStart: number;
}

/** 视图行在选区里的行为。 */
export interface LineMeta {
	/** 行内内容的起始显示列；行号、色带留白等排版前缀不算可选内容 */
	readonly contentStart: number;
	/** 本行是上一条逻辑行的软换行续行：复制时直接接上，不插换行 */
	readonly softWrap: boolean;
}

/** 普通正文行：没有行号前缀，也不是续行。 */
export const PLAIN_LINE_META: LineMeta = { contentStart: 0, softWrap: false };

/** 构建好的对话流：同一帧的测量、绘制与命中都复用它，避免重复换行整份内容。 */
export interface TranscriptView {
	/** 内容区宽度（已扣掉滚动条列） */
	readonly width: number;
	readonly lines: string[];
	/** 每行在选区里的行为，与 lines 一一对应 */
	readonly lineMeta: readonly LineMeta[];
	readonly prompts: PromptRange[];
	/** 每个思考区块标题在 lines 里的起点，双击命中使用 */
	readonly thinkingHeaders: readonly { readonly start: number; readonly block: TranscriptThinking }[];
	/** 每个工具组头在 lines 里的起点，双击命中使用 */
	readonly groupHeaders: readonly { readonly start: number; readonly group: TranscriptToolGroup }[];
	/** 每条可展开的工具行在 lines 里的起点，双击命中使用 */
	readonly toolHeaders: readonly { readonly start: number; readonly tool: TranscriptTool }[];
	/**
	 * 运行中子代理清单行的动画原料：lines 行号 → 重建所需的内容。
	 *
	 * lines 里先放静态占位行（行数一致），渲染期由调用方带当前帧重建为转圈与扫光。
	 * 这样 100ms 一帧的动画不需要重建整份视图。
	 */
	readonly liveLines: ReadonlyMap<number, LiveSubagentLine>;
	/** 每张收尾任务卡的头行在 lines 里的起点，双击收起/展开使用 */
	readonly todoHeaders: readonly { readonly start: number; readonly card: TranscriptTodo }[];
	/** 每张计划卡的头行在 lines 里的起点，双击打开审批页 */
	readonly planHeaders: readonly { readonly start: number; readonly plan: TranscriptPlan }[];
	/** 每个子代理组头在 lines 里的起点，双击收起/展开使用 */
	readonly subagentHeaders: readonly {
		readonly start: number;
		readonly group: TranscriptSubagentGroup;
	}[];
	/** 每条失败的子代理清单行在 lines 里的起点，双击展开/收起失败原因使用 */
	readonly subagentFailureRows: readonly {
		readonly start: number;
		readonly group: TranscriptSubagentGroup;
		readonly callId: string;
	}[];
}

export interface TranscriptMetrics {
	/** 实际写进对话流的行数 */
	readonly totalLines: number;
	/** 加上底部留白后的可滚动行数 */
	readonly scrollLines: number;
	/** 最后一条用户提示的起始行，发送后用它做 page flip */
	readonly lastPromptStart: number;
}
