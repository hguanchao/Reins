import type { AbortCause } from "#src/agent/events.ts";
import { formatDuration } from "#src/shared/format.ts";

/**
 * 界面文案的唯一出处。
 *
 * 只放「会显示给人看的词与句」：状态行、对话流标记、面板与整页文字。排版（颜色、宽度、
 * 折行）留在各自模块，这里只负责措辞，改一处即可全文一致。
 *
 * 组合句一律走下面的构造函数：调用方只传变量，不自己拼词，避免同一件事出现两种说法。
 */

/** 配置不可用时所有命令共用的说明：缺的是 provider，不是「配置」。 */
const NEEDS_CONFIG = "Needs a provider in config.toml";
/** 某能力在当前会话里整体不可用。 */
const NOT_AVAILABLE = "Not available in this session";

// ── 状态行 ────────────────────────────────────────────────────────────────

/**
 * 状态行文案。
 *
 * 进行中的状态统一以省略号收尾（单个 `…`，不用三个点），结局统一是「名词 + failed」；
 * 说不清原因的禁用说明必须带上「为什么」或「怎么办」，不能只写 unavailable。
 */
export const STATUS = {
	waitingForModel: "Waiting for model…",
	waitingForSubagent: "Waiting for subagent…",
	thinking: "Thinking…",
	writingResponse: "Writing response…",
	writingToolCall: "Writing tool call…",
	runningTool: "Running tool…",
	compacting: "Compacting context…",
	stopping: "Stopping…",
	error: "Error",
	/** 配置读不出来：说清是配置内容有问题，并指到文件。 */
	configurationInvalid: "Configuration is invalid · check config.toml",
	/** 存储不可用：说清后果，否则使用者以为会话还在后台保存。 */
	sessionStorageUnavailable: "Session storage unavailable · this session won't be saved",
	agentNotConnected: "Agent not connected",
	pluginCommandsInPlan: "Plugin commands don't run in Plan mode",
	skillsSkipped: "Workspace skills skipped · this workspace isn't trusted",
	restoringCheckpoint: "Restoring checkpoint…",
	readingCheckpoints: "Reading checkpoints…",
	exporting: "Exporting…",
	reviewing: "Reviewing changes…",
	cancellingReview: "Cancelling review…",
	checkingMcp: "Checking MCP servers…",
	mcpHealthCheckComplete: "MCP health check complete",
	mcpHealthCheckFailed: "MCP health check failed",
	mcpReconnectFailed: "MCP reconnect failed",
	readingImage: "Reading image…",
	readingClipboard: "Reading clipboard…",
	readingClipboardImage: "Reading clipboard image…",
	recordingDecision: "Recording the decision…",
	exportFailed: "Export failed",
	reviewFailed: "Review failed",
	copyFailed: "Copy failed",
	copySentToTerminal: "Copy sent to terminal",
	copied: "Copied!",
	nothingToView: "Nothing to view yet",
	planReady: "Plan ready · double-click the plan card to review",
	reviewAlreadyRunning: "A review is already running",
	/** 审查进行中又提交：告诉人怎么取消，而不是只说不能发。 */
	reviewRunningCancel: "A review is running · press Ctrl+C to cancel it",
	imagesUnsupported: "Images aren't supported in this session",
	/** 能力整体不可用：命令清单与状态行共用同一句，避免同一件事两种说法。 */
	planUnavailable: "Plan mode isn't available in this session",
	exportUnavailable: "Session export isn't available in this session",
	reviewUnavailable: "Code review isn't available in this session",
	checkpointsUnavailable: "Checkpoints aren't available in this workspace",
	/** 计划已就绪但这一轮还没跑完，先把顺序说清楚。 */
	approveWhileTurn: "Wait for the running turn to finish, then approve the plan",
	/** 第一次 Esc 只是武装：整段草稿不该被一下按掉。 */
	clearArmed: "Esc again to clear",
	/** 清空之后给出撤销路径，否则使用者只会以为字丢了。 */
	cleared: "Input cleared · Ctrl+Z to undo",
	restored: "Input restored",
} as const;

/** 中断说明：先分类再出句子，拿不准就中性，绝不默认成「是你停的」。 */
export function cancelPhrase(cause: AbortCause | undefined): string {
	if (cause === "user") return "Turn stopped by you";
	if (cause === "session") return "Turn stopped because the session closed";
	return "Turn stopped";
}

/** 重试中的状态：动作在前，原因用 `·` 接在后面，不再拖一个省略号。 */
export function retryStatus(attempt: number, maxAttempts: number, reason: string): string {
	const head = `Retrying ${attempt}/${maxAttempts}`;
	return reason.length === 0 ? `${head}…` : `${head} · ${reason}`;
}

/** 某条命令要等这一轮跑完才能用。 */
export function waitForTurn(command: string): string {
	return `${command}: wait for the running turn to finish`;
}

/** 审查正在跑：挡住的操作要说清什么时候能再用。 */
export function reviewBlocks(action: string): string {
	return `${action}: a review is running, try again when it ends`;
}

/** 队列超出可显示行数。 */
export function queuedOverflow(queued: number, shown: number): string {
	return `${queued} messages queued · showing the first ${shown}`;
}

/** MCP 服务器重连进行中。 */
export function reconnecting(name: string): string {
	return `Reconnecting ${name}…`;
}

/** 插件命令正在执行。 */
export function commandRunning(name: string): string {
	return `Running /${name}…`;
}

/** 桌面通知：命令结束。 */
export function commandFinished(name: string): string {
	return `/${name} finished`;
}

/** 桌面通知：命令失败。 */
export function commandFailed(name: string): string {
	return `/${name} failed`;
}

/** 要求修改计划时预填的输入前缀。 */
export const REVISE_PLAN_PREFIX = "Revise the plan: ";

/** 两段确认：键位在前、动作在后，键位只在这一处维护。 */
/** 启动期 MCP 握手的状态行:带就绪进度,数字随刷新跳动。 */
export function mcpConnectingStatus(ready: number, total: number): string {
	return `Connecting to MCP servers (${ready}/${total} ready)…`;
}

export function pendingConfirm(action: string, key = "Ctrl+C"): string {
	return `${key}: press again to ${action}`;
}

/** 模型已切换；跑到一半时说明从下一轮生效。 */
export function modelSwitched(target: string, fromNextTurn: boolean): string {
	return `Model switched to ${target}${fromNextTurn ? " · applies from the next turn" : ""}.`;
}

/** 思考等级已设置。 */
export function effortSet(level: string, fromNextTurn: boolean): string {
	return `Effort set to ${level}${fromNextTurn ? " · applies from the next turn" : ""}.`;
}

/** 会话已切换。 */
export function switchedSession(id: string): string {
	return `Switched to session ${id}.`;
}

/** 分叉结果：来源、条目数、工作区与检查点的界限。 */
export function forkedSession(origin: string, copied: number): string {
	return `Forked from ${origin} · ${copied} ${copied === 1 ? "entry" : "entries"} copied`;
}

/** 分叉不影响工作区，检查点从分叉处重新开始。 */
export const FORK_WORKSPACE_NOTE = "Workspace unchanged · checkpoints start fresh within the fork.";

/** 审查结束的一行摘要。 */
export function reviewResult(label: string, steps: number, durationMs: number, stopReason: string): string {
	const stepText = `${steps} ${steps === 1 ? "step" : "steps"}`;
	const suffix = stopReason === "done" ? "" : ` · ${stopReason}`;
	return `${label} · ${stepText} · ${formatDuration(durationMs)}${suffix}`;
}

/** 撤销结果。 */
export function undoResult(kind: "turn" | "safety", label: string, restored: number, removed: number): string {
	const verb = kind === "safety" ? "Restored" : "Undid";
	const removedText = removed > 0 ? ` · ${removed} removed` : "";
	return `${verb} ${label} · ${restored} restored${removedText}`;
}

// ── 错误与命令参数 ────────────────────────────────────────────────────────

/** 未知命令。 */
export function unknownCommand(name: string): string {
	return `Unknown command: ${name}`;
}

/** 未知模型：给出可用入口，别让人去翻文档。 */
export function unknownModel(target: string): string {
	return `Error: unknown model: ${target} · run /model to choose from the list`;
}

/** 未知思考等级：顺带列出可选值。 */
export function unknownEffort(target: string, levels: readonly string[]): string {
	return `Error: unknown effort: ${target} · available: ${levels.join(", ")}`;
}

/** 没有可用模型：说明缺什么、去哪补。 */
export const NO_MODELS = "No models configured · add one to providers.json";

/** 失败一律以 `Error:` 开头，后面用 `·` 接一句人话说明失败的动作。 */
export function failure(action: string, error: string): string {
	return `Error: ${action} failed · ${error}`;
}

/** 一串失败句式里的动作名，集中在这里，避免同一个动作有三种拼法。 */
export const FAILURE_ACTIONS = {
	undo: "undo",
	trust: "trust",
	modelSwitch: "model switch",
	effortSet: "effort change",
	planSwitch: "Plan mode switch",
	sessionFork: "session fork",
	approvalSwitch: "approval switch",
	listFiles: "file listing",
	sessionSwitch: "session switch",
	sessionsList: "session listing",
	mcpReconnect: "MCP reconnect",
	mcpHealthCheck: "MCP health check",
	export: "export",
	review: "review",
} as const;

// ── 附件与图片 ────────────────────────────────────────────────────────────

/** 图片数量上限。 */
export function tooManyImages(max: number): string {
	return `Up to ${max} images per message`;
}

/** 单张超限。 */
export function imageTooLarge(name: string, bytes: string, limit: string): string {
	return `Image ${name} is ${bytes}; the limit is ${limit}`;
}

/** 合计超限。 */
export function imagesTooLarge(total: string, limit: string): string {
	return `Attached images total ${total}; the limit is ${limit}`;
}

/** 模型不吃图片：说明它会变成占位符，而不是悄悄丢掉。 */
export function attachedWithoutVision(name: string): string {
	return `Attached ${name} · this model can't read images, so it gets a placeholder`;
}

/** 还在读上一张图，先别发。 */
export const IMAGE_STILL_READING = "Still reading an image; try again in a moment";

// ── 折叠粘贴 ──────────────────────────────────────────────────────────────

/**
 * 大段粘贴折叠成一行标记后的显示文字。
 *
 * 行数优先：多行粘贴用行数更好懂；体积大到行数已经失去意义时（上万行日志）改用大小。
 */
export function pasteChipLines(lines: number): string {
	return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** 体积标签按十进制单位，与文件大小一致。 */
export function pasteChipBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	if (bytes >= 1000) return `${Math.floor(bytes / 1000)} KB`;
	return `${bytes} bytes`;
}

/** 输入框里的折叠标记：带序号，便于同一段内容贴多次时区分与定位。 */
export function pasteMarker(id: number, label: string): string {
	return `[Pasted #${id}: ${label}]`;
}

// ── 对话流 ────────────────────────────────────────────────────────────────

/** 对话流里的标签、空态与折叠提示。 */
export const TRANSCRIPT = {
	/** 工具没有输出。 */
	noOutput: "(no output)",
	/** 历史里没有对应用户消息的助手内容。 */
	earlierConversation: "(earlier conversation)",
	/** 子代理没说原因就失败了。 */
	unknownFailure: "failed without a reason",
	/** 子代理既没结果也没失败，直接被丢了。 */
	subagentNoResult: "the subagent stopped without reporting a result",
	/** 计划卡上的提示。 */
	planHint: " · double-click to view",
	/** 终端过窄时的提示：给出办法，不只报告现状。 */
	terminalTooSmall: "▸ Terminal too small · widen the window",
	/** 警告行的前缀。 */
	warningPrefix: "Warning: ",
} as const;

/** 子代理标签。 */
export function subagentLabel(index: number): string {
	return `Subagent ${index}`;
}

/** 任务条目标签。 */
export function taskLabel(index: number): string {
	return `Task ${index}`;
}

/** 折叠了多少行；能全屏查看时才提键位。 */
export function hiddenLines(hidden: number, viewerKey?: string): string {
	const suffix = viewerKey === undefined ? "" : ` · ${viewerKey}`;
	return `… (${hidden} more lines${suffix})`;
}

/** 列表还有多少条没显示。 */
export function moreItems(hidden: number): string {
	return `… ${hidden} more`;
}

/** 页脚里排队消息的折叠计数。 */
export function queueMore(hidden: number): string {
	return `+${hidden} more`;
}

/** 工具组头：按固定顺序汇总，名词单复数与动词对齐。 */
export function toolGroupSummary(counts: {
	readonly read: number;
	readonly list: number;
	readonly search: number;
	readonly command: number;
}): string {
	const parts: string[] = [];
	if (counts.read > 0) parts.push(`Read ${counts.read} ${counts.read === 1 ? "file" : "files"}`);
	if (counts.list > 0) parts.push(`Listed ${counts.list} ${counts.list === 1 ? "folder" : "folders"}`);
	if (counts.search > 0) {
		parts.push(`Searched ${counts.search} ${counts.search === 1 ? "pattern" : "patterns"}`);
	}
	if (counts.command > 0) {
		parts.push(`Ran ${counts.command} ${counts.command === 1 ? "command" : "commands"}`);
	}
	return parts.join(", ");
}

/** 状态计数段：`1 running · 2 done`。 */
export function countSegments(counts: {
	readonly running?: number;
	readonly done?: number;
	readonly failed?: number;
	readonly pending?: number;
}): string {
	const parts: string[] = [];
	if ((counts.running ?? 0) > 0) parts.push(`${counts.running} running`);
	if ((counts.done ?? 0) > 0) parts.push(`${counts.done} done`);
	if ((counts.failed ?? 0) > 0) parts.push(`${counts.failed} failed`);
	if ((counts.pending ?? 0) > 0) parts.push(`${counts.pending} pending`);
	return parts.join(" · ");
}

/** 后台作业的折叠指标。 */
export function backgroundJob(id: string): string {
	return `background job ${id}`;
}

/**
 * 子代理的统计段：步数与耗时能拿到几个写几个。
 *
 * 历史回填拿不到步数但有时长，不能因为缺一项就整段丢掉。
 */
export function subagentMetric(steps: number | undefined, durationMs: number | undefined): string {
	const parts: string[] = [];
	if (steps !== undefined) parts.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
	if (durationMs !== undefined) parts.push(formatDuration(durationMs));
	return parts.length === 0 ? "" : ` (${parts.join(" · ")})`;
}

// ── 面板 ──────────────────────────────────────────────────────────────────

/** 审批面板与各类菜单的固定文字。 */
export const PANEL = {
	/** 审批卡标题。 */
	permissionRequired: "Permission required",
	/** 展开详情的标题兜底。 */
	details: "Details",
	/** 参数为空。 */
	noArguments: "(no arguments)",
	/** 列表空态：空态是句子，句号收尾。 */
	noMatchingCommands: "No matching commands.",
	noMatchingFiles: "No matching files.",
	noMatchingSkills: "No matching skills.",
	noSessions: "No sessions in this project yet.",
	/** 菜单里的当前项标记。 */
	current: "current",
	/** 顶部视图没有任何可显示的内容。 */
	noContent: "(no content)",
} as const;

/** 整屏查看器的标题：内容来源 + 全文/详情。 */
export const VIEWER_TITLE = {
	thinking: "Thinking",
	prompt: "Prompt",
} as const;

/** 工具输出的标题。 */
export function toolOutputTitle(name: string): string {
	return `${name} output`;
}

/** 工具详情的标题。 */
export function toolDetailsTitle(name: string): string {
	return `${name} details`;
}

/** 读图失败：前缀标明是图片，后面接单行原因。 */
export function imageError(reason: string): string {
	return `Image: ${reason}`;
}

/** 分叉会话在列表里的标题。 */
export function forkOf(source: string): string {
	return `↳ Fork of ${source}`;
}

/** 会话标题为空时的占位。 */
export const UNTITLED_SESSION = "Untitled session";

/** 思考等级说明：光看 low/high 判断不了该选哪档。 */
export const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
	off: "No reasoning; fastest responses",
	low: "Quick tasks where you review each result",
	medium: "Everyday work with a clear scope",
	high: "Work where correctness and edge cases matter",
	xhigh: "Deeper reasoning with higher token cost",
	max: "Hard problems that need sustained reasoning",
};

/** 审批动作：三档写法对称，都写清按下之后会发生什么。 */
export const APPROVAL = {
	proceed: "Yes, proceed",
	deny: "No, deny",
	/** 窄屏退路：只留判定词。 */
	proceedShort: "Yes",
	alwaysShort: "Always",
	denyShort: "No",
} as const;

/** 记住这一档：文件类不重复路径，命令类保留命令前缀，都写清允许的是什么。 */
export function alwaysAllowFile(): string {
	return "Yes, always allow this file";
}

/** 记住某条命令前缀或某个范围。 */
export function alwaysAllowScope(scope: string): string {
	return `Yes, always allow "${scope}"`;
}

// ── 整屏页 ────────────────────────────────────────────────────────────────

/** 帮助页、技能页、MCP 页与信任页的标题与说明。 */
export const PAGE = {
	helpTitle: "Reins · help",
	skillsTitle: "Reins · skills",
	mcpsTitle: "Reins · MCP servers",
	trustTitle: "Reins · workspace trust",
	planTitle: "Reins · plan",
	viewerTitlePrefix: "Reins · ",
	commandsSection: "Commands",
	keysSection: "Keys",
	serversSection: "Servers",
	skillsSection: "Skills",
	userSkillsSection: "User skills",
	projectSkillsSection: "Project skills",
	helpFootnote: "Run reins --help outside the interface for command-line options.",
	noSkills: "No skills yet.",
	skillsEffectNote: "Changes take effect on the next turn.",
	noMcpServers: "No MCP servers configured.",
	mcpConfigNote: "Add [mcp_servers.<name>] to config.toml to connect one.",
	trustIntro: "This workspace ships files that change how Reins behaves.",
	trustNote:
		"Trusting lets those files take effect. They configure this session and their instructions become " +
		"part of the prompt. Commands still run under the sandbox and the approval rules, and this " +
		"workspace cannot add local processes to start.",
	trustSkipNote: "Not trusting keeps the default: nothing from this workspace is loaded.",
	trustFilesSection: "Files Reins may read",
	trustSkillsSection: "Skill folders Reins may load",
} as const;

/** 技能页脚注：扫描过哪些目录。 */
export function scanningDirectory(directory: string): string {
	return `Scanning ${directory}`;
}

/** 信任页的三个选项：记住、仅本次、不信任。 */
export const TRUST_LABELS = {
	full: [
		{ answer: "trust", label: "[y] Trust this workspace" },
		{ answer: "session", label: "[s] Trust for this session" },
		{ answer: "skip", label: "[n] Do not trust" },
	] as const,
	short: [
		{ answer: "trust", label: "[y] Trust" },
		{ answer: "session", label: "[s] Session" },
		{ answer: "skip", label: "[n] Skip" },
	] as const,
	minimal: [
		{ answer: "trust", label: "[y]" },
		{ answer: "session", label: "[s]" },
		{ answer: "skip", label: "[n]" },
	] as const,
} as const;

/** 帮助页的键位清单：键位在前、动作在后，一律用 `·` 分隔；一条只说一件事。 */
export interface KeyHintCopy {
	readonly keys: string;
	readonly description: string;
}

export const KEY_HINTS: readonly KeyHintCopy[] = [
	{ keys: "Enter", description: "Send the prompt · queue it while a turn runs" },
	{ keys: "Shift+Enter", description: "Insert a newline without sending" },
	{ keys: "Tab", description: "Complete the selected item into the prompt" },
	{ keys: "Shift+Tab", description: "Cycle the approval mode: ask, auto, yolo" },
	{ keys: "Esc", description: "Close a menu or this page, or deny an approval" },
	{ keys: "Esc", description: "Interrupt the turn · send the first queued message" },
	{ keys: "Esc twice", description: "Clear the input" },
	{ keys: "Ctrl+Z", description: "Undo the last input change · brings back a cleared draft" },
	{ keys: "Ctrl+C twice", description: "Exit the interface · a draft is cleared first" },
	{ keys: "Up / Down", description: "Prompt cursor or history, menu navigation, or page scrolling" },
	{ keys: "Left / Right", description: "Move the prompt cursor or approval selection" },
	{ keys: "Home / End", description: "Move to the start or end of the input line" },
	{ keys: "Alt+Up", description: "Take the last queued message back into the prompt" },
	{ keys: "Alt+Down", description: "Discard the last queued message" },
	{ keys: "PgUp / PgDn", description: "Scroll the conversation or this page" },
	{ keys: "Ctrl+E", description: "Expand or collapse the latest thinking or tool group" },
	{ keys: "Ctrl+G", description: "View the selected tool full-screen, or the latest long block" },
	{ keys: "Ctrl+V", description: "Paste the clipboard: text inserts like a paste, an image becomes an [image: name] marker" },
	{ keys: "Wheel / drag", description: "Scroll the conversation · drag the scrollbar or select text to copy" },
	{ keys: "Double-click", description: "Expand or collapse thinking, tool groups, or a pasted marker" },
	{ keys: "y / a / n", description: "Answer an approval: proceed once, always allow, or deny" },
	{ keys: "d", description: "Expand or hide approval details · arrow keys scroll them" },
	{ keys: "@", description: "Complete a workspace file path; an image becomes an inline marker" },
	{ keys: "$", description: "Complete a skill; the model reads its SKILL.md when mentioned" },
];

/** 整屏页底部动作条的标签：动作在前，说明它做什么，不写整句。 */
export const ACTIONS = {
	select: "select",
	reconnect: "reconnect",
	healthCheck: "health check",
	close: "close",
	scroll: "scroll",
	page: "page",
	approve: "approve & implement",
	revise: "request changes",
	leave: "leave plan",
	approveShort: "approve",
	reviseShort: "revise",
	leaveShort: "leave",
	back: "back",
} as const;

// ── 命令清单 ──────────────────────────────────────────────────────────────

/** 命令说明：能用的说清做什么，不能用的说清缺什么。 */
export const COMMAND_COPY: Readonly<
	Record<string, { readonly description: string; readonly unavailable: string }>
> = {
	model: { description: "Choose the model for this session", unavailable: NEEDS_CONFIG },
	effort: { description: "Choose the reasoning effort for this session", unavailable: NEEDS_CONFIG },
	compact: { description: "Compact the conversation into a summary now", unavailable: NEEDS_CONFIG },
	plan: {
		description: "Plan in read-only mode, then approve to implement",
		unavailable: STATUS.planUnavailable,
	},
	session: { description: "Switch to another session in this project", unavailable: "Session storage isn't available" },
	export: {
		description: "Export this session to a Markdown or JSONL file",
		unavailable: STATUS.exportUnavailable,
	},
	review: {
		description: "Review current changes in a read-only pass",
		unavailable: STATUS.reviewUnavailable,
	},
	help: { description: "Show the commands and keys", unavailable: NOT_AVAILABLE },
	undo: {
		description: "Undo file changes from the last turn",
		unavailable: STATUS.checkpointsUnavailable,
	},
	skills: { description: "List the skills found on disk", unavailable: NOT_AVAILABLE },
	mcps: {
		description: "List MCP server connections and their tools",
		unavailable: "MCP isn't connected in this session",
	},
};

/** 取命令说明；缺条目时退回命令名，避免整行空白。 */
export function commandDescription(name: string, enabled: boolean): string {
	const copy = COMMAND_COPY[name];
	if (copy === undefined) return name;
	return enabled ? copy.description : copy.unavailable;
}

// ── 通知 ──────────────────────────────────────────────────────────────────

/** 桌面通知正文；标题已经是 Reins，正文不再重复主语。 */
export const NOTIFY = {
	done: "Done",
	failed: "Failed",
} as const;
