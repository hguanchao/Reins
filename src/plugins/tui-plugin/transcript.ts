import { stripVTControlCharacters } from "node:util";

import type { AgentEvent } from "../../agent/events.ts";
import type { SessionHistoryItem } from "../../session/port.ts";
import { ansiLines } from "./ansi.ts";
import {
	alignEnds,
	concat,
	formatDuration,
	lineText,
	lineWidth,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	styled,
	truncateLine,
	wrapLine,
	type Line,
	type Style,
} from "../../tui/index.ts";
import type { CopyAffordance } from "./markdown.ts";
import { formatTokens } from "./format.ts";
import { ACCENT_WIDTH, BLOCK_CONTENT_OFFSET, BLOCK_PAD_LEFT, BLOCK_PAD_RIGHT, entryContentWidth } from "./layout.ts";
import { renderMarkdown, highlightSourceLines } from "./markdown.ts";
import {
	ACCENT,
	BAD,
	BAND,
	CODE_BG,
	COMMAND,
	DIM,
	FAINT,
	OK,
	PATH,
	TEXT,
	THEME,
	USER,
} from "./theme.ts";
import {
	describeTool,
	displayToolName,
	firstLine,
	thoughtLabel,
	timestampText,
	toolFilePath,
} from "./transcript-format.ts";
import { groupKindOf, groupLabel, runningGroupLabel } from "./transcript-group.ts";
import { agentLine, blockLine, pulseStyle, rail } from "./transcript-style.ts";

/**
 * 会话的显示状态。
 *
 * 主区按「块」保存与排版：每个块都有自己的展开/收起状态，界面只负责把块摊成行、画选中框、
 * 把鼠标行号映射回块。块的内容按当前宽度重新排版，所以窗口变化时历史也会跟着重排。
 *
 * 块与块之间留一行空白；用户消息整块铺底并上下各留一行，思考与工具块带彩色竖线。模型正文
 * 没有竖线，但仍保留竖线列与左留白，和工具正文从同一列开始。连续的可汇总工具（读取、检索、
 * 列目录）会折叠成一行「◈ Read 3 files」；展开后逐个列出成员。
 *
 * 流式输出按 markdown 渲染，每次按当前宽度重新排版；块的状态与命中位置由 view() 一并摊开。
 */

/** 推理内容只留最后几行做预览。它是模型的草稿，占满屏幕会把正文挤走。 */
const REASONING_PREVIEW_LINES = 3;

/** 用户消息收起时最多显示几行。 */
const USER_PREVIEW_LINES = 3;

/** 用户与模型消息右侧留出的时间戳宽度。 */
const TIMESTAMP_WIDTH = 10;

/** 工具行/思考行的前缀，与正文区分开。 */
const TOOL_MARK = "◆ ";
const THOUGHT_MARK = "◇ ";
/** 汇总组的组头单独用一个空心菱形，和组内成员的工具行区分开。 */
const GROUP_MARK = "◈ ";

/** 工具/思考完成后的绿色闪烁时长；与参考实现一致。 */
const FINISH_FLASH_MS = 400;

/** 工具行的右端离块右缘的距离：耗时对齐到这里。 */
const HEADER_WIDTH = (entryWidth: number): number => Math.max(1, entryWidth - BLOCK_PAD_RIGHT);

/** 展开的读取详情：开头与结尾各保留几行，中间用 ⋮ 省略。 */
const READ_FIRST_LINES = 5;
const READ_LAST_LINES = 3;

/** 其他工具的展开输出只留最后几行，更早的省略。 */
const TOOL_TAIL_LINES = 12;

/** 差异可以长一些，但仍给一个上限。 */
const EDIT_MAX_LINES = 24;

/** 收起组超过这么多参与行时，组头只报「N more」。 */
const GROUP_MAX_VISIBLE = 10;

/**
 * 列表输出里的条目数：截断过的输出自带「N entries」标记，完整清单按行数数。
 */
/**
 * 工具输出可能是另一个终端程序写的：里面会带颜色转义与回车覆盖。
 *
 * 这些字节直接写进界面会改掉屏幕颜色、把光标移回行首。这里统一去掉转义序列，并把
 * `\r\n` / 单独的回车折成普通换行；颜色不保留，但内容完整可读。
 */
function cleanToolOutput(text: string): string {
	return stripVTControlCharacters(text.replaceAll("\r\n", "\n").replaceAll("\r", ""));
}

/** 实时预览的最后一行：保留颜色，按显示宽度取最后一个非空行。 */
function lastAnsiLine(text: string): Line | undefined {
	const lines = ansiLines(text, { color: DIM.color });
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lineWidth(lines[index]) > 0) return lines[index];
	}
	return undefined;
}

/** 编辑默认展开差异；其余工具先收成一行。 */
function defaultToolMode(name: string): BlockMode {
	return name.toLowerCase() === "edit" ? "expanded" : "collapsed";
}

/** 收起时只显示文件名；路径与范围在后缀里分开。 */
function collapsedArgs(block: ToolBlock): string {
	const name = block.name.toLowerCase();
	if (name !== "read" && name !== "edit" && name !== "write") return block.args;
	const { path, suffix } = splitArgs(block.args);
	return `${basename(path)}${suffix}`;
}

interface ReadRange {
	readonly start: number;
	readonly end: number;
	readonly total: number;
}

/** Read 的结构化行范围；工具没带 details 时返回 undefined。 */
function readRange(details: unknown): ReadRange | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	const start = record["startLine"];
	const end = record["endLine"];
	const total = record["totalLines"];
	if (typeof start !== "number" || typeof end !== "number" || typeof total !== "number") {
		return undefined;
	}
	return { start, end, total };
}

/** 把 `path (10–15)` 拆成路径与括号后缀。 */
function splitArgs(args: string): { readonly path: string; readonly suffix: string } {
	const index = args.lastIndexOf(" (");
	if (index < 0) return { path: args, suffix: "" };
	return { path: args.slice(0, index), suffix: args.slice(index) };
}

function basename(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized.split("/").at(-1) ?? normalized;
}

/** 差异里的新增/删除行数；没有差异标记时返回 undefined。 */
function diffCounts(output: string): { readonly added: number; readonly removed: number } | undefined {
	const start = output.indexOf("@@");
	if (start < 0) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of output.slice(start).split("\n")) {
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed };
}

/** 数满足条件的行；一行都没有时返回 undefined，避免显示 `(0 …)`。 */
function countLines(output: string, match: (line: string) => boolean): number | undefined {
	let count = 0;
	for (const line of output.split("\n")) {
		if (match(line)) count += 1;
	}
	return count === 0 ? undefined : count;
}

function countEntries(output: string): number | undefined {
	const marked = /(\d+) entries/.exec(output);
	const markedCount = Number(marked?.[1]);
	if (Number.isFinite(markedCount) && markedCount > 0) return markedCount;
	const lines = output.split("\n").filter((line) => line.trim().length > 0);
	return lines.length > 0 ? lines.length : undefined;
}

export type BlockKind = "user" | "agent" | "thinking" | "tool" | "group" | "system";
export type BlockMode = "collapsed" | "truncated" | "expanded";

/** 一个已定型块在行数组里的位置；界面用它做命中测试与选中框。 */
export interface BlockSpan {
	readonly id: number;
	readonly kind: BlockKind;
	readonly foldable: boolean;
	readonly mode: BlockMode;
	/** 块第一行在行数组里的下标。 */
	readonly start: number;
	/** 块占的行数。 */
	readonly height: number;
}

export interface TranscriptView {
	readonly rows: readonly Line[];
	readonly blocks: readonly BlockSpan[];
	/** 每个使用者的回合起始行号；右侧轨道按它画刻度。 */
	readonly turns: readonly number[];
	/** 与 turns 一一对应：该回合第一行文本，轨道悬停时用作预览。 */
	readonly turnPreviews: readonly string[];
	/** 消息时间戳的位置与原始时刻，悬停时用来展开完整日期。 */
	readonly timestamps: readonly TimestampSpan[];
	/** 块下操作行里的可点击复制区域；列相对正文区，界面按块缩进换算。 */
	readonly copies: readonly CopyRegion[];
}

/** 一个 [Copy …] 标签的位置与点击后应写入剪贴板的内容。 */
export interface CopyRegion {
	readonly row: number;
	readonly from: number;
	readonly to: number;
	readonly content: string;
}

/** 一个时间戳在行数组里的位置；列相对条目行。 */
export interface TimestampSpan {
	readonly row: number;
	readonly col: number;
	readonly width: number;
	readonly createdAt: number;
}

export interface ViewOptions {
	/** 活动块最多占几行，超出的部分从上往下丢弃。 */
	readonly maxLiveRows?: number;
	/** 当前时刻；测试可以传入固定值来检查完成闪烁。 */
	readonly now?: number;
}

interface BlockBase {
	readonly id: number;
	mode: BlockMode;
}

interface UserBlock extends BlockBase {
	readonly kind: "user";
	readonly text: string;
	readonly createdAt: number;
}

interface AgentBlock extends BlockBase {
	readonly kind: "agent";
	readonly text: string;
	readonly createdAt: number;
	/** 显示 markdown 源码而不是渲染结果 */
	raw: boolean;
}

interface ThinkingBlock extends BlockBase {
	readonly kind: "thinking";
	readonly text: string;
	readonly elapsedMs: number;
	readonly finishedAt: number;
}

interface ToolBlock extends BlockBase {
	readonly kind: "tool";
	readonly name: string;
	readonly args: string;
	/** 工具作用的主要文件：读取详情按它的扩展名挑语法着色 */
	readonly path: string | undefined;
	readonly output: string;
	readonly isError: boolean;
	readonly durationMs: number;
	readonly finishedAt: number;
	/** 工具给界面的结构化信息，例如 Read 的总行数 */
	readonly details?: unknown;
}

interface SystemBlock extends BlockBase {
	readonly kind: "system";
	readonly lines: readonly Line[];
	readonly accent: Style | undefined;
}

type Block = UserBlock | AgentBlock | ThinkingBlock | ToolBlock | SystemBlock;

interface RunningTool {
	readonly callId: string;
	readonly name: string;
	readonly args: string;
	readonly path: string | undefined;
	readonly startedAt: number;
	update: string | undefined;
}

/** 一次连续的可汇总工具扫描；end 是扫描停下时下一个块的下标。 */
interface GroupRun {
	readonly members: readonly ToolBlock[];
	readonly end: number;
	/** 这一段里占可见行的块数（工具与被吸收的思考） */
	readonly participants: number;
}

export class Transcript {
	/** 条目总宽：竖线、左右留白与正文一起。 */
	#width: number;	#blocks: Block[] = [];
	#nextId = 1;
	/** 展开的汇总组，按组内第一个工具块的 id 记。 */
	#expandedGroups = new Set<number>();
	/** 最近一次扫描出的汇总组：组头 id（用锚点成员 id 的负值，避免与成员冲突）→ 成员工具块。 */
	#groupAnchors = new Map<number, ToolBlock[]>();
	#streaming = "";
	#streamStartedAt: number | undefined;
	#reasoning = "";
	#reasoningStartedAt: number | undefined;
	#running: RunningTool[] = [];
	/** 工作目录：工具参数里的绝对路径显示成相对路径。 */
	#cwd: string | undefined = undefined;
	/** 最近渲染的模型正文里带出的复制操作行；view() 换算成绝对行号。 */
	#mdCopies: readonly CopyAffordance[] = [];

	constructor(width: number) {
		this.#width = Math.max(1, width);
	}

	/** 窗口尺寸变了，后续按新宽度重排。块的状态不受影响。 */
	resize(width: number): void {
		this.#width = Math.max(1, width);
	}

	/** 会话的工作目录，用来把工具参数里的绝对路径缩成相对路径。 */
	setCwd(cwd: string): void {
		this.#cwd = cwd;
	}

	/**
	 * 使用者提交了一句话。
	 *
	 * 长消息默认收起：整段铺满屏幕会把模型刚给出的结果推到看不见的地方，超过预览行数的
	 * 消息先折成三行，需要时再展开。
	 */
	userTurn(text: string, now = Date.now()): void {
		const mode = this.#userWrapped(text).length > USER_PREVIEW_LINES ? "collapsed" : "expanded";
		this.#blocks.push({ id: this.#nextId++, kind: "user", text, createdAt: now, mode });
	}

	/** 追加一段不带块样式的内容（命令输出、系统提示），整体作为一个不可折叠的系统块。 */
	appendSystem(lines: readonly Line[], accent?: Style): void {
		if (lines.length === 0) return;
		this.#blocks.push({ id: this.#nextId++, kind: "system", lines, mode: "expanded", accent });
	}

	/**
	 * 接续旧会话时把历史一次性铺进会话区。
	 *
	 * 历史已经是「人看的样子」，不经过流式事件，也不会触发完成闪烁；时间戳用条目自己的
	 * 时间，回看时能对上是哪一天说的。
	 */
	appendHistory(items: readonly SessionHistoryItem[]): void {
		for (const item of items) {
			switch (item.kind) {
				case "user": {
					const mode = this.#userWrapped(item.text).length > USER_PREVIEW_LINES ? "collapsed" : "expanded";
					this.#blocks.push({ id: this.#nextId++, kind: "user", text: item.text, createdAt: item.at, mode });
					continue;
				}
				case "assistant":
					if (item.text.length > 0) {
						this.#blocks.push({
							id: this.#nextId++,
							kind: "agent",
							text: item.text,
							createdAt: item.at,
							raw: false,
							mode: "expanded",
						});
					}
					continue;
				case "thinking":
					this.#blocks.push({
						id: this.#nextId++,
						kind: "thinking",
						text: item.text,
						elapsedMs: item.elapsedMs,
						finishedAt: item.at,
						mode: "collapsed",
					});
					continue;
				case "tool":
					this.#blocks.push({
						id: this.#nextId++,
						kind: "tool",
						name: item.name,
						args: describeTool(item.name, item.args, this.#cwd),
						path: toolFilePath(item.name, item.args),
						output: item.output,
						isError: item.isError,
						durationMs: 0,
						finishedAt: item.at,
						mode: defaultToolMode(item.name),
					});
					continue;
				case "system":
					this.appendSystem([styled(item.text, DIM)]);
					continue;
			}
		}
	}

	/** 处理一个事件。块的增删都发生在这里，界面随后重画。 */
	handle(event: AgentEvent, now: number): void {
		switch (event.type) {
			case "text_delta":
				this.#closeThinking(now);
				this.#streamStartedAt ??= now;
				this.#streaming += event.text;
				return;
			case "reasoning_delta":
				this.#reasoningStartedAt ??= now;
				this.#reasoning += event.text;
				return;
			case "tool_start":
				this.#closeThinking(now);
				this.#commitStream();
				this.#running.push({
					callId: event.callId,
					name: event.name,
					args: describeTool(event.name, event.args, this.#cwd),
					path: toolFilePath(event.name, event.args),
					startedAt: now,
					update: undefined,
				});
				return;
			case "tool_update": {
				const tool = this.#running.find((item) => item.callId === event.callId);
				if (tool !== undefined) tool.update = event.text;
				return;
			}
			case "tool_end": {
				this.#closeThinking(now);
				this.#commitStream();
				const index = this.#running.findIndex((item) => item.callId === event.callId);
				const tool = index < 0 ? undefined : this.#running.splice(index, 1)[0];
				this.#blocks.push({
					id: this.#nextId++,
					kind: "tool",
					name: event.name,
					args: tool?.args ?? "",
					path: tool?.path,
					output: tool?.update ?? event.content ?? event.summary,
					isError: event.isError,
					durationMs: event.durationMs,
					finishedAt: now,
					details: event.details,
					mode: defaultToolMode(event.name),
				});
				return;
			}
			case "error":
				this.#closeThinking(now);
				this.#commitStream();
				this.#blocks.push({
					id: this.#nextId++,
					kind: "system",
					lines: [styled(`✗ Error: ${event.message}`, BAD)],
					mode: "expanded",
					accent: BAD,
				});
				return;
			case "aborted":
				this.#closeThinking(now);
				this.#commitStream();
				this.#blocks.push({
					id: this.#nextId++,
					kind: "system",
					lines: [styled("◇ Cancelled", DIM)],
					mode: "expanded",
					accent: undefined,
				});
				return;
			case "compaction_start":
				this.#closeThinking(now);
				this.#commitStream();
				this.#blocks.push({
					id: this.#nextId++,
					kind: "system",
					lines: [
						styled(
							`Context is long; summarizing the previous ${event.messages} messages (~${formatTokens(event.tokensBefore)} tokens)`,
							DIM,
						),
					],
					mode: "expanded",
					accent: undefined,
				});
				return;
			case "compaction_end":
				this.#blocks.push({
					id: this.#nextId++,
					kind: "system",
					lines: [
						styled(
							`Context compacted: ${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens; the full history is still in the session file`,
							DIM,
						),
					],
					mode: "expanded",
					accent: undefined,
				});
				return;
			case "compaction_failed":
				this.#blocks.push({
					id: this.#nextId++,
					kind: "system",
					lines: [styled(`Compaction failed; continuing with the full context: ${event.message}`, DIM)],
					mode: "expanded",
					accent: undefined,
				});
				return;
			case "run_end":
				this.flush(now);
				return;
			default:
				return;
		}
	}

	/** 本轮结束：把剩下的回答与思考收干净。 */
	flush(now: number): void {
		this.#closeThinking(now);
		this.#commitStream();
	}

	/** 回合完成后在正文末尾补一行耗时；中止的回合不补。 */
	turnCompleted(elapsedMs: number, now: number): void {
		this.#closeThinking(now);
		this.appendSystem([styled(`Worked for ${formatDuration(elapsedMs)}`, DIM)]);
	}

	/** 本轮中止或出错后，工具痕迹不该留在屏幕上。 */
	clearRunning(): void {
		this.#running = [];
	}

	/**
	 * 把已提交的块和活动块摊成行。
	 *
	 * 活动块只追加在末尾，不参与折叠与命中测试；它们随时会变成定型块。
	 */
	view(options: ViewOptions = {}): TranscriptView {
		const now = options.now ?? Date.now();
		const rows: Line[] = [];
		const blocks: BlockSpan[] = [];
		const turns: number[] = [];
		const turnPreviews: string[] = [];
		const timestamps: TimestampSpan[] = [];
		let first = true;

		interface SpanInfo {
			readonly id: number;
			readonly kind: BlockKind;
			readonly mode: BlockMode;
			readonly foldable: boolean;
			/** 使用者回合的第一行文本，供轨道预览。 */
			readonly preview?: string;
			/** 用户或模型消息的创建时刻，供时间戳悬停。 */
			readonly timestamp?: number;
		}

		const push = (lines: readonly Line[], span: SpanInfo | undefined, tight = false): void => {
			if (lines.length === 0) return;
			// 块与块之间固定留一行；组头与成员之间不留，保持密集
			if (!first && !tight) rows.push([]);
			first = false;
			const start = rows.length;
			rows.push(...lines);
			if (span === undefined) return;

			blocks.push({ ...span, start, height: lines.length });
			if (span.kind === "user") {
				turns.push(start);
				turnPreviews.push(span.preview ?? "");
			}
			if (span.timestamp !== undefined) {
				for (let row = start; row < start + lines.length; row += 1) {
					const text = lineText(rows[row]);
					const matches = [...text.matchAll(/\d{1,2}:\d{2} (?:AM|PM)/g)];
					const match = matches.at(-1);
					if (match?.index === undefined) continue;
					timestamps.push({
						row,
						col: match.index,
						width: match[0].length,
						createdAt: span.timestamp,
					});
					break;
				}
			}
		};

		this.#syncGroups();
		const copies: CopyRegion[] = [];
		for (let index = 0; index < this.#blocks.length; index += 1) {
			const block = this.#blocks[index];
			const run = this.#groupRunAt(index);
			if (run !== undefined) {
				const members = run.members;
				const anchor = members[0];
				const groupId = -anchor.id;
				const expanded = this.#expandedGroups.has(groupId);
				push([this.#groupHeader(run, expanded)], {
					id: groupId,
					kind: "group",
					mode: expanded ? "expanded" : "collapsed",
					foldable: true,
				});
				if (expanded) {
					// 展开组：成员各自成块，默认仍是折叠的一行，可以单独再展开看输出
					for (const member of members) {
						push(this.#toolLines(member, false, now), {
							id: member.id,
							kind: "tool",
							mode: member.mode,
							foldable: true,
						}, true);
					}
				}
				// 组里可能夹着已经被吸收的思考块，直接跳到扫描停下的位置
				index = run.end - 1;
				continue;
			}

			const blockLines = this.#renderBlock(block, now);
			push(blockLines, {
				id: block.id,
				kind: block.kind,
				mode: block.mode,
				foldable: this.#foldable(block),
				preview: block.kind === "user" ? firstLine(block.text) : undefined,
				timestamp: block.kind === "user" || block.kind === "agent" ? block.createdAt : undefined,
			});
			// 块下操作行里的可点击区域：换成行数组的绝对行号
			for (const copy of this.#mdCopies) {
				copies.push({
					row: rows.length - blockLines.length + copy.line,
					from: copy.from,
					to: copy.to,
					content: copy.content,
				});
			}
		}

		let live = this.#liveRows(now);
		if (options.maxLiveRows !== undefined && live.length > options.maxLiveRows) {
			live = [styled("…", DIM), ...live.slice(live.length - options.maxLiveRows + 1)];
		}
		if (live.length > 0) {
			if (!first) rows.push([]);
			rows.push(...live);
		}

		return { rows, blocks, turns, turnPreviews, timestamps, copies };
	}

	/** 切换一个块的展开/收起；不可折叠的块原样返回。 */
	toggleFold(id: number): void {
		this.#syncGroups();
		if (this.#groupAnchors.has(id)) {
			if (this.#expandedGroups.has(id)) this.#expandedGroups.delete(id);
			else this.#expandedGroups.add(id);
			return;
		}

		const block = this.#blocks.find((item) => item.id === id);
		if (block === undefined || !this.#foldable(block)) return;
		block.mode = block.mode === "expanded" ? "collapsed" : "expanded";
	}

	/** 收起一个块；已经收起的保持原状。 */
	collapse(id: number): void {
		this.#syncGroups();
		if (this.#groupAnchors.has(id)) {
			this.#expandedGroups.delete(id);
			return;
		}

		const block = this.#blocks.find((item) => item.id === id);
		if (block !== undefined && this.#foldable(block)) block.mode = "collapsed";
	}

	/** 展开一个块；已经展开的保持原状。 */
	expand(id: number): void {
		this.#syncGroups();
		if (this.#groupAnchors.has(id)) {
			this.#expandedGroups.add(id);
			return;
		}

		const block = this.#blocks.find((item) => item.id === id);
		if (block !== undefined && this.#foldable(block)) block.mode = "expanded";
	}

	/** 切换一条模型回答的 markdown 源码/渲染视图。 */
	toggleRaw(id: number): boolean {
		const block = this.#blocks.find((item) => item.id === id);
		if (block === undefined || block.kind !== "agent") return false;
		block.raw = !block.raw;
		return true;
	}

	/** 全部展开或全部收起：只要还有展开的就全部收起，否则全部展开。 */
	toggleAll(): void {
		this.#syncGroups();
		const foldable = this.#blocks.filter((block) => this.#foldable(block));
		const groups = [...this.#groupAnchors.keys()];
		const collapse =
			foldable.some((block) => block.mode === "expanded") ||
			groups.some((id) => this.#expandedGroups.has(id));

		for (const block of foldable) block.mode = collapse ? "collapsed" : "expanded";
		for (const id of groups) {
			if (collapse) this.#expandedGroups.delete(id);
			else this.#expandedGroups.add(id);
		}
	}

	/** 只切换思考块。 */
	toggleAllThinking(): void {
		const thinking = this.#blocks.filter((block) => block.kind === "thinking");
		const collapse = thinking.some((block) => block.mode === "expanded");
		for (const block of thinking) block.mode = collapse ? "collapsed" : "expanded";
	}

	/** 一个块的完整正文，折叠状态下也返回全部内容；用于复制。 */
	blockText(id: number): string | undefined {
		this.#syncGroups();
		const members = this.#groupAnchors.get(id);
		if (members !== undefined) return members.map((member) => this.#toolText(member)).join("\n\n");

		const block = this.#blocks.find((item) => item.id === id);
		if (block === undefined) return undefined;

		switch (block.kind) {
			case "user":
			case "agent":
			case "thinking":
				return block.text;
			case "tool":
				return block.output.length > 0 ? block.output : `${block.name} ${block.args}`.trim();
			case "system":
				return block.lines.map(lineText).join("\n");
			default:
				return undefined;
		}
	}

	/** 块的元信息：工具调用返回工具名与参数，汇总组按成员逐条返回。 */
	blockMeta(id: number): string | undefined {
		this.#syncGroups();
		const members = this.#groupAnchors.get(id);
		if (members !== undefined) return members.map((member) => this.#toolMeta(member)).join("\n\n");

		const block = this.#blocks.find((item) => item.id === id);
		return block?.kind === "tool" ? this.#toolMeta(block) : undefined;
	}

	/** 工具的主参数（路径、命令、查询），供单独复制。 */
	blockPrimary(id: number): string | undefined {
		this.#syncGroups();
		const members = this.#groupAnchors.get(id);
		if (members !== undefined) {
			const args = members.map((member) => member.args).filter((value) => value.length > 0);
			return args.length === 0 ? undefined : args.join("\n");
		}

		const block = this.#blocks.find((item) => item.id === id);
		return block?.kind === "tool" && block.args.length > 0 ? block.args : undefined;
	}

	#toolMeta(member: ToolBlock): string {
		return `${displayToolName(member.name)}${member.args.length > 0 ? ` ${member.args}` : ""}`;
	}

	/** 扫描连续的可汇总工具，记下每个组的组头 id 与成员。 */
	#syncGroups(): void {
		this.#groupAnchors.clear();
		for (let index = 0; index < this.#blocks.length; index += 1) {
			const run = this.#groupRunAt(index);
			if (run === undefined) continue;
			this.#groupAnchors.set(-run.members[0].id, [...run.members]);
			index = run.end - 1;
		}
	}

	/**
	 * 扫描一段连续的可汇总工具。
	 *
	 * 已经收起的思考块会被这一组吸收：模型常在两次工具调用之间想一句，那些草稿不该把
	 * 「Read 3 files」拆成三段。展开的思考仍然保留自己的行，并中断这一段扫描。
	 */
	#groupRunAt(index: number): GroupRun | undefined {
		const first = this.#blocks[index];
		if (first === undefined || first.kind !== "tool" || groupKindOf(first.name) === undefined) {
			return undefined;
		}

		const members: ToolBlock[] = [];
		let cursor = index;
		while (cursor < this.#blocks.length) {
			const block = this.#blocks[cursor];
			if (block.kind === "tool" && groupKindOf(block.name) !== undefined) {
				members.push(block);
				cursor += 1;
				continue;
			}
			if (block.kind === "thinking" && block.mode === "collapsed") {
				cursor += 1;
				continue;
			}
			break;
		}
		return { members, end: cursor, participants: cursor - index };
	}

	#groupHeader(run: GroupRun, expanded: boolean): Line {
		const { label, failed } = groupLabel(run.members);
		// 很长的收起组只报剩余行数：展开后才给出按动词聚合的完整标签
		const truncated = !expanded && run.participants > GROUP_MAX_VISIBLE + 1;
		const text = truncated ? `${run.participants - 1} more` : label;
		return blockLine(
			plain(" "),
			truncateLine(
				concat(
					styled(`${GROUP_MARK}`, DIM),
					styled(text, { bold: true, color: THEME.grayBright }),
					failed > 0 ? styled(` · ${failed} failed`, BAD) : plain(""),
				),
				this.#contentWidth(),
			),
		);
	}

	#toolText(member: ToolBlock): string {
		const header = `${member.name}${member.args.length > 0 ? ` ${member.args}` : ""}`;
		return member.output.length > 0 ? `${header}\n${member.output}` : header;
	}

	#renderBlock(block: Block, now: number): readonly Line[] {
		switch (block.kind) {
			case "user":
				return this.#userLines(block);
			case "agent":
				return this.#agentLines(block);
			case "thinking":
				return this.#thinkingLines(block, now);
			case "tool":
				return this.#toolLines(block, false, now);
			case "system":
				return this.#systemLines(block);
			default:
				return [];
		}
	}

	#userLines(block: UserBlock): readonly Line[] {
		const collapsed = block.mode === "collapsed";
		// 符号直接贴着色带左缘，缩进格全部去掉；续行对齐到符号后的正文列
		const lines = this.#userWrapped(block.text, collapsed ? USER_PREVIEW_LINES : undefined);
		const contentWidth = this.#contentWidth();
		const time = styled(timestampText(block.createdAt), DIM);
		const band = (line: Line, index: number): Line => {
			const withTime =
				index === 0 ? alignEnds(line, time, BLOCK_CONTENT_OFFSET + contentWidth) : line;
			return this.#band(withTime, this.#width);
		};
		const blank = this.#band(plain(""), this.#width);
		return [blank, ...lines.map(band), blank];
	}

	#agentLines(block: AgentBlock): readonly Line[] {
		const contentWidth = this.#contentWidth();
		const width = Math.max(1, contentWidth - TIMESTAMP_WIDTH);
		const rendered = block.raw
			? { lines: wrapLine(styled(block.text, TEXT), { width }), copies: [] }
			: renderMarkdown(block.text, { width });
		this.#mdCopies = rendered.copies;
		const lines = rendered.lines.map(agentLine);
		const first = lines.findIndex((line) => line.length > 0);
		if (first >= 0) {
			lines[first] = alignEnds(
				lines[first],
				styled(timestampText(block.createdAt), DIM),
				BLOCK_CONTENT_OFFSET + contentWidth,
			);
		}
		return lines;
	}

	#thinkingLines(block: ThinkingBlock, now: number): readonly Line[] {
		const collapsed = block.mode === "collapsed";
		const flashing = !collapsed && now - block.finishedAt < FINISH_FLASH_MS;
		const accent = collapsed ? undefined : flashing ? OK : ACCENT;
		const thought = thoughtLabel(block.elapsedMs);
		const elapsed = thought.indexOf(" for ");
		const label = concat(
			styled(THOUGHT_MARK, FAINT),
			styled(elapsed < 0 ? thought : thought.slice(0, elapsed), { bold: true, color: DIM.color }),
			elapsed < 0 ? plain("") : styled(thought.slice(elapsed), DIM),
		);
		// 收起时补一条展开提示；放不下就整条省略，不把提示截成半句
		const hint = plain("  (ctrl+e to expand)");
		const content =
			collapsed && lineWidth(label) + lineWidth(hint) <= this.#contentWidth()
				? concat(label, hint)
				: label;
		const header = blockLine(rail(accent), content);
		if (collapsed) return [header];

		const body = wrapLine(mapLine(plain(block.text), (style) => mergeStyles(style, DIM)), {
			width: this.#contentWidth(),
		});
		return [header, ...body.map((line) => blockLine(rail(accent), line))];
	}

	#toolLines(block: ToolBlock, forceExpanded: boolean, now: number): readonly Line[] {
		const collapsed = !forceExpanded && block.mode === "collapsed";
		// 工具行不画竖线：展开后详情自己成一块面板，竖线只会把头与正文切开。
		// 完成时闪的绿落在菱形上；失败保持红色，不会被完成闪烁盖掉。
		const flashing = !collapsed && !block.isError && now - block.finishedAt < FINISH_FLASH_MS;
		const mark = block.isError ? BAD : flashing ? OK : FAINT;
		const detail = block.isError ? plain("") : (this.#toolDetail(block) ?? plain(""));
		const head = blockLine(
			rail(undefined),
			concat(styled(TOOL_MARK, mark), this.#toolTitle(block, collapsed), detail),
		);
		const header = truncateLine(head, HEADER_WIDTH(this.#width));
		if (collapsed || block.output.length === 0) return [header];
		return [header, ...this.#toolBody(block)];
	}

	/**
	 * 工具头：动词加粗，参数跟在后面一个空格。
	 *
	 * 收起时整行压到次要色，路径只留文件名——排在一起的工具调用不该抢正文的注意力；
	 * 展开后才恢复主色，路径、命令与查询各用自己的颜色。
	 */
	#toolTitle(block: ToolBlock, collapsed: boolean): Line {
		const nameStyle: Style = collapsed
			? { bold: true, color: DIM.color }
			: { bold: true, color: block.isError ? BAD.color : TEXT.color };
		return concat(styled(displayToolName(block.name), nameStyle), this.#toolArgs(block, collapsed));
	}

	#toolArgs(block: ToolBlock, collapsed: boolean): Line {
		if (block.args.length === 0) return plain("");
		const name = block.name.toLowerCase();

		// Read 的路径与行范围在收起/展开两种状态下都要带上；范围用工具给的结构化数据修正
		if (name === "read") {
			const { path, suffix } = splitArgs(block.args);
			const range = readRange(block.details);
			const shownRange =
				range === undefined || suffix.length === 0
					? suffix
					: range.total > range.end - range.start + 1
						? ` (${range.start}–${range.end} of ${range.total})`
						: ` (${range.start}–${range.end})`;
			if (collapsed) return styled(` ${basename(path)}${shownRange}`, DIM);
			return concat(
				styled(` ${path}`, block.isError ? BAD : PATH),
				shownRange.length === 0 ? plain("") : styled(shownRange, DIM),
			);
		}

		const args = collapsed ? collapsedArgs(block) : block.args;
		if (collapsed) return styled(` ${args}`, DIM);
		if (name === "bash" || name === "shell") return styled(` ${args}`, COMMAND);
		if (name === "edit" || name === "write" || name === "ls" || name === "list_dir") {
			const { path, suffix } = splitArgs(args);
			return concat(
				styled(` ${path}`, block.isError ? BAD : PATH),
				suffix.length === 0 ? plain("") : styled(suffix, DIM),
			);
		}
		if (name === "grep" || name === "glob") {
			const match = /^("[^"]*")(.*)$/.exec(args);
			if (match !== null) {
				return concat(styled(` ${match[1]}`, OK), styled(match[2], PATH));
			}
		}
		if (name === "find") {
			const match = /^(.*?)( in )(.*)$/.exec(args);
			if (match !== null) {
				return concat(styled(` ${match[1]}`, OK), styled(match[2], DIM), styled(match[3], PATH));
			}
		}
		return styled(` ${args}`, block.isError ? BAD : TEXT);
	}

	/** 收起行的括号详情：列表给条目数，检索给命中数，编辑给增删行数。 */
	#toolDetail(block: ToolBlock): Line | undefined {
		const name = block.name.toLowerCase();
		const output = cleanToolOutput(block.output);
		if (name === "edit") {
			const counts = diffCounts(output);
			if (counts === undefined) return undefined;
			return concat(
				styled(` +${counts.added}`, OK),
				styled("/", DIM),
				styled(`-${counts.removed}`, BAD),
			);
		}
		if (name === "grep") {
			let matches = 0;
			const files = new Set<string>();
			for (const line of output.split("\n")) {
				const match = /^(.*?):\d+: /.exec(line);
				if (match === null) continue;
				matches += 1;
				files.add(match[1]);
			}
			if (matches === 0) return undefined;
			const matchNoun = matches === 1 ? "match" : "matches";
			const fileNoun = files.size === 1 ? "file" : "files";
			return styled(` (${matches} ${matchNoun} in ${files.size} ${fileNoun})`, FAINT);
		}
		if (name === "find" || name === "glob") {
			const count = countLines(output, (line) => line.length > 0 && !line.startsWith("["));
			return count === undefined ? undefined : styled(` (${count} files)`, FAINT);
		}
		if (groupKindOf(block.name) === "dir") {
			const count = countEntries(output);
			if (count === undefined) return undefined;
			return styled(` (${count} entries)`, FAINT);
		}
		return undefined;
	}

	/**
	 * 展开的工具正文。
	 *
	 * 读取类给行号预览，其余只留最后一段输出；两者都缩到正文列、铺同一层面板底色、不画竖线——
	 * 详情是挂在工具头下面的正文，再拉一条竖线会把它和头割成两块。
	 */
	#toolBody(block: ToolBlock): readonly Line[] {
		const lines = cleanToolOutput(block.output).split("\n");
		// 失败时输出是错误说明，不是结构化结果；先统一按红字铺开
		if (block.isError) return this.#tailBody(lines, (text) => styled(text, BAD));

		const name = block.name.toLowerCase();
		if (name === "read") return this.#numberedBody(lines, block.path);
		if (name === "edit") return this.#editBody(lines);
		if (name === "grep") return this.#searchBody(lines);
		if (name === "find" || name === "glob") return this.#pathListBody(lines);
		// 执行类与未知工具保留 ANSI 颜色；结构化工具上面的文本分支不需要
		return this.#ansiBody(block.output);
	}

	/** 通用工具输出：保留命令自己的颜色，只留最后几行。 */
	#ansiBody(text: string): readonly Line[] {
		const lines = ansiLines(text, { color: TEXT.color, background: THEME.codeBg });
		const shown = lines.length > TOOL_TAIL_LINES ? [undefined, ...lines.slice(-TOOL_TAIL_LINES)] : lines;
		const rows: Line[] = [];
		if (shown[0] === undefined) rows.push(this.#detailLine(styled("⋮", DIM)));
		for (const line of shown) {
			if (line === undefined) continue;
			for (const wrapped of wrapLine(line, { width: this.#contentWidth() })) {
				rows.push(this.#ansiLine(wrapped));
			}
		}
		return rows;
	}

	/** ANSI 行：有背景的片段保留自己的底色，其余补面板底色。 */
	#ansiLine(line: Line): Line {
		const width = this.#contentWidth();
		const filled = mapLine(line, (style) =>
			style?.background === undefined ? (mergeStyles(style, CODE_BG) ?? CODE_BG) : style,
		);
		return concat(plain(" ".repeat(BLOCK_CONTENT_OFFSET)), padLine(filled, width, CODE_BG));
	}

	/**
	 * 编辑详情：只画差异部分。
	 *
	 * 工具输出开头还有一行「更新了哪个文件」，工具头已经写了，正文从第一个 `@@` 开始。
	 * 新增与删除行各自铺底色，和代码块的面板区分开。
	 */
	#editBody(lines: readonly string[]): readonly Line[] {
		const start = lines.findIndex((line) => line.startsWith("@@"));
		if (start < 0) return this.#tailBody(lines, (text) => styled(text, DIM), EDIT_MAX_LINES);

		const diff = lines.slice(start);
		const entries: ({ readonly text: string; readonly style: Style; readonly band?: Style; readonly number?: number } | undefined)[] = [];
		let oldLine = 0;
		let newLine = 0;
		let delta = 0;

		for (const text of diff) {
			if (text.startsWith("@@")) {
				const match = /@@ line (\d+) @@/.exec(text);
				if (match !== null) {
					oldLine = Number(match[1]);
					newLine = oldLine + delta;
				}
				entries.push({ text, style: DIM });
				continue;
			}
			if (text.startsWith("+")) {
				entries.push({
					text,
					number: newLine,
					style: { color: OK.color, background: THEME.diffInsertBg },
					band: { background: THEME.diffInsertBg },
				});
				newLine += 1;
				delta += 1;
				continue;
			}
			if (text.startsWith("-")) {
				entries.push({
					text,
					number: oldLine,
					style: { color: BAD.color, background: THEME.diffDeleteBg },
					band: { background: THEME.diffDeleteBg },
				});
				oldLine += 1;
				continue;
			}
			entries.push({ text, number: newLine, style: DIM, band: CODE_BG });
			oldLine += 1;
			newLine += 1;
		}

		const shown = entries.length > EDIT_MAX_LINES ? [undefined, ...entries.slice(-EDIT_MAX_LINES + 1)] : entries;
		const rows: Line[] = [];
		for (const entry of shown) {
			if (entry === undefined) {
				rows.push(this.#detailLine(styled("⋮", DIM)));
				continue;
			}
			if (entry.number === undefined) {
				rows.push(this.#detailLine(styled(entry.text, entry.style)));
				continue;
			}
			rows.push(this.#diffLine(entry.number, entry.text, entry.style, entry.band ?? CODE_BG));
		}
		return rows;
	}

	/** 差异行：行号留在底色之外，正文按增删铺满整行。 */
	#diffLine(number: number, text: string, style: Style, band: Style): Line {
		const gutter = styled(`${String(number).padStart(4)}  `, DIM);
		const width = Math.max(1, this.#contentWidth() - 6);
		const body = padLine(
			truncateLine(mapLine(styled(text, style), (span) => mergeStyles(span, band) ?? band), width),
			width,
			band,
		);
		return concat(plain(" ".repeat(BLOCK_CONTENT_OFFSET)), gutter, body);
	}

	/**
	 * 检索详情：按文件分组。
	 *
	 * 每个文件先占一行路径，命中行缩进并带上行号；同一文件的命中连在一起，跨文件之间空
	 * 一行。这样比一长串 `path:line: text` 更容易扫。
	 */
	#searchBody(lines: readonly string[]): readonly Line[] {
		const shown = lines.length > TOOL_TAIL_LINES ? [undefined, ...lines.slice(-TOOL_TAIL_LINES)] : lines;
		const rows: Line[] = [];
		let lastPath: string | undefined;

		for (const text of shown) {
			if (text === undefined) {
				rows.push(this.#detailLine(styled("⋮", DIM)));
				continue;
			}
			const match = /^(.*?):(\d+): (.*)$/.exec(text);
			if (match === null) {
				rows.push(this.#detailLine(styled(text, text.startsWith("[") ? DIM : TEXT)));
				continue;
			}

			const [, path, line, content] = match;
			if (path !== lastPath) {
				if (lastPath !== undefined) rows.push(this.#detailLine(plain("")));
				rows.push(this.#detailLine(styled(path, PATH)));
				lastPath = path;
			}
			rows.push(
				this.#detailLine(
					concat(plain("  "), styled(line.padStart(4), DIM), plain("  "), styled(content, TEXT)),
				),
			);
		}
		return rows;
	}

	/** 路径清单：每行一个路径，末尾的截断说明压暗。 */
	#pathListBody(lines: readonly string[]): readonly Line[] {
		return this.#tailBody(lines, (text) =>
			text.startsWith("[") ? styled(text, DIM) : styled(text, PATH),
		);
	}

	/** 只留最后几行；更早的内容用一行 ⋮ 代替。 */
	#tailBody(
		lines: readonly string[],
		render: (text: string) => Line,
		maxLines = TOOL_TAIL_LINES,
	): readonly Line[] {
		const shown = lines.length > maxLines ? [undefined, ...lines.slice(-maxLines)] : lines;
		const rows: Line[] = [];
		if (shown[0] === undefined) rows.push(this.#detailLine(styled("⋮", DIM)));
		for (const text of shown) {
			if (text === undefined) continue;
			for (const wrapped of wrapLine(render(text), { width: this.#contentWidth() })) {
				rows.push(this.#detailLine(wrapped));
			}
		}
		return rows;
	}

	/**
	 * 读取详情的行号预览：开头多行加结尾多行，中间用 ⋮ 省略。整块缩到正文列（与工具头同一列）
	 * 并铺代码底色，行号用次要色，正文按文件类型着色——和模型正文里的代码块是同一种画法。
	 */
	#numberedBody(lines: readonly string[], path: string | undefined): readonly Line[] {
		const total = lines.length;
		const segments =
			total > READ_FIRST_LINES + READ_LAST_LINES
				? [
						{ from: 0, to: READ_FIRST_LINES },
						{ from: total - READ_LAST_LINES, to: total },
					]
				: [{ from: 0, to: total }];
		const gutterWidth = String(total).length;
		// 着色按整段算：逐行着理会丢掉跨行的注释与多行字符串
		const colored = highlightSourceLines(lines.join("\n"), path, TEXT);
		const rows: Line[] = [];
		for (const segment of segments) {
			if (segment.from > 0 && rows.length > 0) rows.push(this.#detailLine(styled("⋮", DIM)));
			for (let index = segment.from; index < segment.to; index += 1) {
				const number = String(index + 1).padStart(gutterWidth);
				const width = Math.max(1, this.#contentWidth() - gutterWidth - 2);
				const source = colored[index] ?? styled(lines[index] ?? "", TEXT);
				for (const wrapped of wrapLine(source, { width })) {
					rows.push(this.#detailLine(concat(styled(`${number}  `, DIM), wrapped)));
				}
			}
		}
		return rows;
	}

	/**
	 * 详情行：缩到正文列（与工具头同列），整行铺面板底色。
	 *
	 * 差异行自己带了底色时沿用它的底色，其余行统一用代码块底色；这样新增/删除的整行
	 * 都连成一片，而不是只有文字背后有颜色。
	 */
	#detailLine(line: Line): Line {
		const background = line.find((span) => span.style?.background !== undefined)?.style?.background;
		const band: Style = background === undefined ? CODE_BG : { background };
		return concat(
			plain(" ".repeat(BLOCK_CONTENT_OFFSET)),
			padLine(mapLine(line, (style) => mergeStyles(style, band) ?? band), this.#contentWidth(), band),
		);
	}

	#systemLines(block: SystemBlock): readonly Line[] {
		return block.lines.flatMap((line) =>
			wrapLine(line, { width: this.#contentWidth() }).map((wrapped) => blockLine(rail(block.accent), wrapped)),
		);
	}

	/** 活动块：推理预览、流式回答、正在跑的工具。 */
	#liveRows(now: number): Line[] {
		const parts: Line[][] = [];

		if (this.#reasoning.length > 0) {
			const accent = pulseStyle(now, 0);
			const lines: Line[] = [
				blockLine(
					rail(accent),
					concat(
						styled(THOUGHT_MARK, accent),
						styled("Thinking…", { bold: true, color: DIM.color }),
					),
				),
			];
			const preview = wrapLine(mapLine(plain(this.#reasoning), (style) => mergeStyles(style, DIM)), {
				width: this.#contentWidth(),
			});
			lines.push(
				...preview
					.slice(-REASONING_PREVIEW_LINES)
					.map((line, index) => blockLine(rail(pulseStyle(now, index + 1)), line)),
			);
			parts.push(lines);
		}

		if (this.#streaming.length > 0) {
			parts.push(renderMarkdown(this.#streaming, { width: this.#contentWidth() }).lines.map(agentLine));
		}

		// 连续的可汇总工具也合成一行，动词用进行时；单个工具同样收起参数，和定型后的组头一致
		let index = 0;
		while (index < this.#running.length) {
			const tool = this.#running[index];
			if (groupKindOf(tool.name) === undefined) {
				parts.push([this.#liveToolLine(tool, now)]);
				index += 1;
				continue;
			}
			const members: RunningTool[] = [];
			while (index < this.#running.length && groupKindOf(this.#running[index].name) !== undefined) {
				members.push(this.#running[index]);
				index += 1;
			}
			parts.push([this.#runningGroupLine(members, now)]);
		}

		const lines: Line[] = [];
		for (const part of parts) {
			if (part.length === 0) continue;
			if (lines.length > 0) lines.push([]);
			lines.push(...part);
		}
		return lines;
	}

	/** 正在跑的工具：竖线与菱形带上明暗波，右边带上最近一行输出。 */
	#liveToolLine(tool: RunningTool, now: number): Line {
		const accent = pulseStyle(now);
		const head = blockLine(
			rail(accent),
			concat(
				styled(TOOL_MARK, accent),
				styled(displayToolName(tool.name), { bold: true, color: TEXT.color }),
				plain(tool.args.length === 0 ? "" : ` ${tool.args}`),
			),
		);

		const tail = tool.update === undefined ? undefined : lastAnsiLine(tool.update);
		if (tail === undefined) return truncateLine(head, HEADER_WIDTH(this.#width));
		const right = truncateLine(tail, Math.max(1, Math.floor(this.#contentWidth() / 3)));
		const headLimit = Math.max(1, HEADER_WIDTH(this.#width) - lineWidth(right) - 1);
		return alignEnds(truncateLine(head, headLimit), right, HEADER_WIDTH(this.#width));
	}

	/** 正在跑的汇总组：用进行时聚合，不给每个调用单独刷一行细节。 */
	#runningGroupLine(members: readonly RunningTool[], now: number): Line {
		const label = runningGroupLabel(members);
		const accent = pulseStyle(now);
		return truncateLine(
			blockLine(
				rail(accent),
				concat(styled(GROUP_MARK, accent), styled(label, { bold: true, color: THEME.grayBright })),
			),
			HEADER_WIDTH(this.#width),
		);
	}

	/** 整行铺底：底色要盖住文字，所以先把样式并到每个片段上，再补满到条目总宽。 */
	#band(line: Line, width: number): Line {
		return padLine(mapLine(line, (style) => mergeStyles(style, BAND)), width, BAND);
	}

	#closeThinking(now: number): void {
		if (this.#reasoning.length === 0) return;
		this.#blocks.push({
			id: this.#nextId++,
			kind: "thinking",
			text: this.#reasoning,
			elapsedMs: now - (this.#reasoningStartedAt ?? now),
			finishedAt: now,
			mode: "collapsed",
		});
		this.#reasoning = "";
		this.#reasoningStartedAt = undefined;
	}

	#commitStream(): void {
		if (this.#streaming.length === 0) return;
		this.#blocks.push({
			id: this.#nextId++,
			kind: "agent",
			text: this.#streaming,
			createdAt: this.#streamStartedAt ?? Date.now(),
			raw: false,
			mode: "expanded",
		});
		this.#streaming = "";
		this.#streamStartedAt = undefined;
	}

	#foldable(block: Block): boolean {
		switch (block.kind) {
			case "user":
				return this.#userWrapped(block.text).length > USER_PREVIEW_LINES;
			case "thinking":
			case "tool":
				return true;
			default:
				return false;
		}
	}

	/**
	 * 用户消息按当前宽度折行。
	 *
	 * 首行有 ❯ 前缀、续行有两格缩进，两者都计入可用宽度；右侧还要给时间戳留一栏。
	 * 判断「默认要不要收起」和真正排版用的是同一份结果，收起阈值才不会和屏上看到的行数对不上。
	 */
	#userWrapped(text: string, maxLines?: number): readonly Line[] {
		const contentWidth = this.#contentWidth();
		const textWidth = contentWidth + ACCENT_WIDTH + BLOCK_PAD_LEFT - BLOCK_PAD_RIGHT;
		return wrapLine(styled(text, TEXT), {
			width: Math.max(1, textWidth - TIMESTAMP_WIDTH),
			firstIndent: styled("❯ ", USER),
			restIndent: plain("  "),
			maxLines,
		});
	}

	#contentWidth(): number {
		return entryContentWidth(this.#width);
	}
}
