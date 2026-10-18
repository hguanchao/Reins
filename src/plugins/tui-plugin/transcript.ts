import type { AgentEvent } from "../../agent/events.ts";
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
import { ACCENT, BAD, BAND, BRIGHT, CODE_BG, DIM, FAINT, OK, TEXT } from "./theme.ts";
import {
	describeTool,
	displayToolName,
	firstLine,
	lastOutputLine,
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

/** 工具/思考完成后的绿色闪烁时长；与参考实现一致。 */
const FINISH_FLASH_MS = 400;

/** 工具行的右端离块右缘的距离：耗时对齐到这里。 */
const HEADER_WIDTH = (entryWidth: number): number => Math.max(1, entryWidth - BLOCK_PAD_RIGHT);

/** 展开的读取详情：开头与结尾各保留几行，中间用 ⋮ 省略。 */
const READ_FIRST_LINES = 5;
const READ_LAST_LINES = 3;

/** 其他工具的展开输出只留最后几行，更早的省略。 */
const TOOL_TAIL_LINES = 12;

/**
 * 列表输出里的条目数：截断过的输出自带「N entries」标记，完整清单按行数数。
 */
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

	/** 使用者提交了一句话：新建一个展开的用户块。 */
	userTurn(text: string, now = Date.now()): void {
		this.#blocks.push({ id: this.#nextId++, kind: "user", text, createdAt: now, mode: "expanded" });
	}

	/** 追加一段不带块样式的内容（命令输出、系统提示），整体作为一个不可折叠的系统块。 */
	appendSystem(lines: readonly Line[], accent?: Style): void {
		if (lines.length === 0) return;
		this.#blocks.push({ id: this.#nextId++, kind: "system", lines, mode: "expanded", accent });
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
					mode: "collapsed",
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
			const members = this.#groupRunAt(index);
			if (members !== undefined) {
				const anchor = members[0];
				const groupId = -anchor.id;
				const expanded = this.#expandedGroups.has(groupId);
				push([this.#groupHeader(members)], {
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
				index += members.length - 1;
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

	#toolMeta(member: ToolBlock): string {
		return `${member.name}${member.args.length > 0 ? ` ${member.args}` : ""}`;
	}

	/** 扫描连续的可汇总工具，记下每个组的组头 id 与成员。 */
	#syncGroups(): void {
		this.#groupAnchors.clear();
		for (let index = 0; index < this.#blocks.length; index += 1) {
			const members = this.#groupRunAt(index);
			if (members === undefined) continue;
			this.#groupAnchors.set(-members[0].id, members);
			index += members.length - 1;
		}
	}

	#groupRunAt(index: number): ToolBlock[] | undefined {
		const first = this.#blocks[index];
		if (first === undefined || first.kind !== "tool" || groupKindOf(first.name) === undefined) {
			return undefined;
		}

		const members: ToolBlock[] = [];
		for (let cursor = index; cursor < this.#blocks.length; cursor += 1) {
			const block = this.#blocks[cursor];
			if (block.kind !== "tool" || groupKindOf(block.name) === undefined) break;
			members.push(block);
		}
		return members;
	}

	#groupHeader(members: readonly ToolBlock[]): Line {
		const { label, failed } = groupLabel(members);
		return blockLine(
			plain(" "),
			truncateLine(
				concat(
					styled(`${TOOL_MARK}`, FAINT),
					styled(label, { bold: true, color: BRIGHT.color }),
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
		const contentWidth = this.#contentWidth();
		// 符号直接贴着色带左缘，缩进格全部去掉；续行对齐到符号后的正文列
		const textWidth = contentWidth + ACCENT_WIDTH + BLOCK_PAD_LEFT - BLOCK_PAD_RIGHT;
		const lines = wrapLine(plain(block.text), {
			width: Math.max(1, textWidth - TIMESTAMP_WIDTH),
			firstIndent: styled("❯ ", ACCENT),
			restIndent: plain("  "),
			maxLines: collapsed ? USER_PREVIEW_LINES : undefined,
		});
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
		const rendered = renderMarkdown(block.text, { width: Math.max(1, contentWidth - TIMESTAMP_WIDTH) });
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
		const label = concat(styled(THOUGHT_MARK, FAINT), styled(thoughtLabel(block.elapsedMs), DIM));
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
		// 折叠行没有竖线，和参考实现的折叠态一致；展开后才画出块的范围
		const flashing = !collapsed && now - block.finishedAt < FINISH_FLASH_MS;
		const accent = collapsed ? undefined : flashing ? OK : block.isError ? BAD : FAINT;
		const mark = block.isError ? BAD : FAINT;
		const detail = block.isError ? styled(" (failed)", BAD) : (this.#listDetail(block) ?? plain(""));
		const head = blockLine(
			rail(accent),
			concat(
				styled(TOOL_MARK, mark),
				styled(displayToolName(block.name), block.isError ? BAD : TEXT),
				plain(block.args === "" ? "" : `  ${block.args}`),
				detail,
			),
		);
		const header = truncateLine(head, HEADER_WIDTH(this.#width));
		if (collapsed || block.output.length === 0) return [header];
		return [header, ...this.#toolBody(block)];
	}

	/** 收起行的括号详情：列表工具给出条目数，其余工具不啰嗦。 */
	#listDetail(block: ToolBlock): Line | undefined {
		if (groupKindOf(block.name) !== "dir") return undefined;
		const count = countEntries(block.output);
		if (count === undefined) return undefined;
		return styled(` (${count} entries)`, FAINT);
	}

	/**
	 * 展开的工具正文。
	 *
	 * 读取类给行号预览，其余只留最后一段输出；两者都缩到正文列、铺同一层面板底色、不画竖线——
	 * 详情是挂在工具头下面的正文，再拉一条竖线会把它和头割成两块。
	 */
	#toolBody(block: ToolBlock): readonly Line[] {
		const lines = block.output.split("\n");
		if (block.name.toLowerCase() === "read") return this.#numberedBody(lines, block.path);

		const shown = lines.length > TOOL_TAIL_LINES ? [undefined, ...lines.slice(-TOOL_TAIL_LINES)] : lines;
		const rows: Line[] = [];
		if (shown[0] === undefined) rows.push(this.#detailLine(styled("⋮", DIM)));
		for (const text of shown) {
			if (text === undefined) continue;
			for (const wrapped of wrapLine(styled(text, block.isError ? BAD : TEXT), { width: this.#contentWidth() })) {
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

	/** 详情行：缩到正文列（与工具头同列），整行铺面板底色，续行与行号共用同一层。 */
	#detailLine(line: Line): Line {
		return concat(
			plain(" ".repeat(BLOCK_CONTENT_OFFSET)),
			padLine(mapLine(line, (style) => mergeStyles(style, CODE_BG) ?? CODE_BG), this.#contentWidth(), CODE_BG),
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
				blockLine(rail(accent), concat(styled(THOUGHT_MARK, accent), styled("Thinking…", DIM))),
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
				styled(displayToolName(tool.name), TEXT),
				plain(tool.args.length === 0 ? "" : ` ${tool.args}`),
			),
		);

		const tail = lastOutputLine(tool.update);
		if (tail === undefined) return truncateLine(head, HEADER_WIDTH(this.#width));
		const right = truncateLine(styled(tail, DIM), Math.max(1, Math.floor(this.#contentWidth() / 3)));
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
				concat(styled(TOOL_MARK, accent), styled(label, { bold: true, color: BRIGHT.color })),
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
			mode: "expanded",
		});
		this.#streaming = "";
		this.#streamStartedAt = undefined;
	}

	#foldable(block: Block): boolean {
		switch (block.kind) {
			case "user":
				return wrapLine(plain(block.text), { width: this.#contentWidth() }).length > USER_PREVIEW_LINES;
			case "thinking":
			case "tool":
				return true;
			default:
				return false;
		}
	}

	#contentWidth(): number {
		return entryContentWidth(this.#width);
	}
}
