import type { AgentEvent } from "../../agent/events.ts";
import {
	alignEnds,
	concat,
	lineText,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	styled,
	truncateLine,
	wrapLine,
	type Line,
	type Rgb,
	type Style,
} from "../../tui/index.ts";
import { formatDuration } from "../../tui/widgets/spinner.ts";
import { formatTokens } from "./format.ts";
import { ACCENT_WIDTH, BLOCK_CONTENT_OFFSET, BLOCK_PAD_LEFT, BLOCK_PAD_RIGHT, entryContentWidth } from "./layout.ts";
import { renderMarkdown } from "./markdown.ts";
import { ACCENT, BAD, BAND, BRIGHT, DIM, FAINT, OK, TEXT, THEME } from "./theme.ts";

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
 * 流式输出按 markdown 渲染，并且跟踪「已经交出去几行」：重新渲染整段文本后再跳过前面已
 * 提交的部分，得到的就是还没显示的尾部。这样不必去维护文本偏移量与行号之间的换算。
 */

/** 推理内容只留最后几行做预览。它是模型的草稿，占满屏幕会把正文挤走。 */
const REASONING_PREVIEW_LINES = 3;

/** 用户消息收起时最多显示几行。 */
const USER_PREVIEW_LINES = 3;

/** 用户与模型消息右侧留出的时间戳宽度。 */
const TIMESTAMP_WIDTH = 10;

/** 工具参数在界面上只显示个大概，完整内容在会话文件里。 */
const ARGS_LIMIT = 60;

/** 块的左侧竖线：思考与工具块靠它标出范围。 */
const BAR = "┃";

/** 工具行/思考行的前缀，与正文区分开。 */
const TOOL_MARK = "◆ ";
const THOUGHT_MARK = "◇ ";

/** 工具/思考完成后的绿色闪烁时长；与参考实现一致。 */
const FINISH_FLASH_MS = 400;

/** 正在跑的块：沿块内行号传播的明暗波，周期约四分之一秒。 */
const PULSE_RADIANS_PER_MS = 1 / 240;
const PULSE_MIN = 0.35;

/** 工具行的右端离块右缘的距离：耗时对齐到这里。 */
const HEADER_WIDTH = (entryWidth: number): number => Math.max(1, entryWidth - BLOCK_PAD_RIGHT);

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
	readonly output: string;
	readonly isError: boolean;
	readonly durationMs: number;
	readonly finishedAt: number;
}

type ToolGroupKind = "file" | "search" | "dir" | "web";

const GROUP_VERBS: Readonly<
	Record<ToolGroupKind, { readonly done: string; readonly running: string; readonly one: string; readonly many: string }>
> = {
	file: { done: "Read", running: "Reading", one: "file", many: "files" },
	search: { done: "Searched", running: "Searching", one: "pattern", many: "patterns" },
	dir: { done: "Listed", running: "Listing", one: "dir", many: "dirs" },
	web: { done: "Fetched", running: "Fetching", one: "website", many: "websites" },
};

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
	readonly startedAt: number;
	update: string | undefined;
}

export class Transcript {
	/** 条目总宽：竖线、左右留白与正文一起。 */
	#width: number;	#blocks: Block[] = [];
	#nextId = 1;
	/** 展开的汇总组，按组内第一个工具块的 id 记。 */
	#expandedGroups = new Set<number>();
	/** 最近一次扫描出的汇总组：组头 id → 成员工具块。 */
	#groupAnchors = new Map<number, ToolBlock[]>();
	#streaming = "";
	#streamStartedAt: number | undefined;
	#reasoning = "";
	#reasoningStartedAt: number | undefined;
	#running: RunningTool[] = [];

	constructor(width: number) {
		this.#width = Math.max(1, width);
	}

	/** 窗口尺寸变了，后续按新宽度重排。块的状态不受影响。 */
	resize(width: number): void {
		this.#width = Math.max(1, width);
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
					args: summarizeArgs(event.args),
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
					output: tool?.update ?? event.summary,
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
		let first = true;

		interface SpanInfo {
			readonly id: number;
			readonly kind: BlockKind;
			readonly mode: BlockMode;
			readonly foldable: boolean;
		}

		const push = (lines: readonly Line[], span: SpanInfo | undefined): void => {
			if (lines.length === 0) return;
			// 块与块之间固定留一行：用户消息自己的上下留白是块内空间，不再兼作块间距
			if (!first) rows.push([]);
			first = false;
			const start = rows.length;
			rows.push(...lines);
			if (span === undefined) return;

			blocks.push({ ...span, start, height: lines.length });
			if (span.kind === "user") turns.push(start);
		};

		this.#syncGroups();
		for (let index = 0; index < this.#blocks.length; index += 1) {
			const block = this.#blocks[index];
			const members = this.#groupRunAt(index);
			if (members !== undefined) {
				const anchor = members[0];
				const expanded = this.#expandedGroups.has(anchor.id);
				push(this.#groupLines(members, expanded, now), {
					id: anchor.id,
					kind: "group",
					mode: expanded ? "expanded" : "collapsed",
					foldable: true,
				});
				index += members.length - 1;
				continue;
			}

			push(this.#renderBlock(block, now), {
				id: block.id,
				kind: block.kind,
				mode: block.mode,
				foldable: this.#foldable(block),
			});
		}

		let live = this.#liveRows(now);
		if (options.maxLiveRows !== undefined && live.length > options.maxLiveRows) {
			live = [styled("…", DIM), ...live.slice(live.length - options.maxLiveRows + 1)];
		}
		if (live.length > 0) {
			if (!first) rows.push([]);
			rows.push(...live);
		}

		return { rows, blocks, turns };
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

	/** 扫描连续的可汇总工具，记下每个组的组头 id 与成员。 */
	#syncGroups(): void {
		this.#groupAnchors.clear();
		for (let index = 0; index < this.#blocks.length; index += 1) {
			const members = this.#groupRunAt(index);
			if (members === undefined) continue;
			this.#groupAnchors.set(members[0].id, members);
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

	/** 汇总组：收起时只有组头，展开后逐个列出成员工具的完整内容。 */
	#groupLines(members: readonly ToolBlock[], expanded: boolean, now: number): readonly Line[] {
		const header = this.#groupHeader(members);
		if (!expanded) return [header];

		const lines: Line[] = [header];
		for (const member of members) {
			lines.push([]);
			lines.push(...this.#toolLines(member, true, now));
		}
		return lines;
	}

	#groupHeader(members: readonly ToolBlock[]): Line {
		const buckets = new Map<ToolGroupKind, number>();
		let failed = 0;
		for (const member of members) {
			const kind = groupKindOf(member.name);
			if (kind === undefined) continue;
			buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
			if (member.isError) failed += 1;
		}

		let label = "";
		for (const [kind, count] of buckets) {
			const verb = GROUP_VERBS[kind];
			if (label.length > 0) label += ", ";
			label += `${verb.done} ${count} ${count === 1 ? verb.one : verb.many}`;
		}

		return blockLine(
			plain(" "),
			concat(
				styled("◈ ", failed > 0 ? BAD : FAINT),
				styled(label, { bold: true, color: BRIGHT.color }),
				failed > 0 ? styled(` · ${failed} failed`, BAD) : plain(""),
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
		const lines = wrapLine(plain(block.text), {
			width: Math.max(1, contentWidth - TIMESTAMP_WIDTH),
			firstIndent: styled("› ", ACCENT),
			restIndent: plain("  "),
			maxLines: collapsed ? USER_PREVIEW_LINES : undefined,
		});
		const prefix = plain(" ".repeat(ACCENT_WIDTH + BLOCK_PAD_LEFT));
		const time = styled(timestampText(block.createdAt), DIM);
		const band = (line: Line, index: number): Line => {
			const content = concat(prefix, line);
			const withTime =
				index === 0 ? alignEnds(content, time, BLOCK_CONTENT_OFFSET + contentWidth) : content;
			return this.#band(withTime, this.#width);
		};
		const blank = this.#band(plain(""), this.#width);
		return [blank, ...lines.map(band), blank];
	}

	#agentLines(block: AgentBlock): readonly Line[] {
		const contentWidth = this.#contentWidth();
		const lines = renderMarkdown(block.text, { width: Math.max(1, contentWidth - TIMESTAMP_WIDTH) }).lines.map(
			agentLine,
		);
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
		const header = blockLine(
			rail(accent),
			concat(styled(THOUGHT_MARK, FAINT), styled(thoughtLabel(block.elapsedMs), DIM)),
		);
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
		const header = alignEnds(
			blockLine(
				rail(accent),
				concat(
					styled(TOOL_MARK, mark),
					styled(block.name, block.isError ? BAD : TEXT),
					plain(block.args === "" ? "" : ` ${block.args}`),
				),
			),
			styled(formatDuration(block.durationMs), DIM),
			HEADER_WIDTH(this.#width),
		);
		if (collapsed || block.output.length === 0) return [header];

		const body = wrapLine(styled(block.output, block.isError ? BAD : DIM), {
			width: this.#contentWidth(),
		});
		return [header, ...body.map((line) => blockLine(rail(accent), line))];
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

		for (const tool of this.#running) parts.push([this.#liveToolLine(tool, now)]);

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
				styled(tool.name, TEXT),
				plain(tool.args.length === 0 ? "" : ` ${tool.args}`),
			),
		);

		const tail = lastOutputLine(tool.update);
		if (tail === undefined) return head;
		return alignEnds(head, truncateLine(styled(tail, DIM), Math.max(1, Math.floor(this.#contentWidth() / 3))), HEADER_WIDTH(this.#width));
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

/** 块的左竖线；没有颜色时留一格空白，正文列不会因为块类型而漂移。 */
function rail(style: Style | undefined): Line {
	return style === undefined ? plain(" ") : styled(BAR, style);
}

/** 竖线、正文前留白与正文。 */
function blockLine(accent: Line, content: Line): Line {
	return concat(accent, plain(" ".repeat(BLOCK_PAD_LEFT)), content);
}

/** 模型正文没有竖线，但仍保留竖线列与左留白，和工具行从同一列开始。 */
function agentLine(line: Line): Line {
	return line.length === 0 ? [] : blockLine(plain(" "), line);
}

/** 运行中块的强调色：沿行号错开相位的明暗波。 */
function pulseStyle(now: number, row = 0): Style {
	const wave = (Math.sin(now * PULSE_RADIANS_PER_MS + row * 0.9) + 1) / 2;
	return { color: blend(THEME.base, THEME.accent, PULSE_MIN + (1 - PULSE_MIN) * wave) };
}

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
	return [
		Math.round(from[0] + (to[0] - from[0]) * amount),
		Math.round(from[1] + (to[1] - from[1]) * amount),
		Math.round(from[2] + (to[2] - from[2]) * amount),
	];
}

function thoughtLabel(elapsedMs: number): string {
	return `Thought for ${formatDuration(elapsedMs)}`;
}

/** 消息右上角的时间：小时不补零，分补零，12 小时制。 */
function timestampText(ms: number): string {
	const date = new Date(ms);
	const hour = date.getHours() % 12 || 12;
	const minute = date.getMinutes().toString().padStart(2, "0");
	const suffix = date.getHours() < 12 ? "AM" : "PM";
	return `  ${hour}:${minute} ${suffix}`;
}

/** 把工具参数压成一行：界面上只显示个大概。 */
function summarizeArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	if (text === undefined || text === "{}") return "";
	return text.length > ARGS_LIMIT ? `${text.slice(0, ARGS_LIMIT)}…` : text;
}

/** 可汇总的工具按动词归类；其余工具（写文件、编辑、执行命令）各自成行。 */
function groupKindOf(name: string): ToolGroupKind | undefined {
	switch (name.toLowerCase()) {
		case "read":
			return "file";
		case "grep":
		case "find":
		case "glob":
			return "search";
		case "ls":
		case "list_dir":
			return "dir";
		case "webfetch":
		case "web_fetch":
		case "websearch":
		case "web_search":
			return "web";
		default:
			return undefined;
	}
}

/** 阶段性输出的最后一行：它是给「还在动」这件事作证的。 */
function lastOutputLine(update: string | undefined): string | undefined {
	if (update === undefined) return undefined;
	const lines = update.split("\n").filter((line) => line.trim().length > 0);
	return lines.at(-1);
}
