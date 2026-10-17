import type { AgentEvent } from "../../agent/events.ts";
import {
	cellIndexAtColumn,
	concat,
	padLine,
	plain,
	Viewport,
	type Line,
	type ViewportWindow,
} from "../../tui/index.ts";
import {
	drawCopyIcon,
	drawHoverCard,
	drawSelectionBand,
	drawSelectionBox,
	expandTimestamp,
} from "./conversation-view.ts";
import { GUTTER_WIDTH, CONTENT_OFFSET, OUTER_PAD } from "./layout.ts";
import { appendRail, railCells, railWidth, RAIL_WIDTH } from "./rail.ts";
import { scrollbarCell } from "./scrollbar.ts";
import { fullTimestamp } from "./session-format.ts";
import {
	highlightSelection,
	selectionRange,
	selectionText,
	type SelectionPoint,
	type SelectionRegion,
} from "./selection.ts";
import { Transcript, type BlockSpan, type TimestampSpan } from "./transcript.ts";

/**
 * 主区控制器。
 *
 * 会话记录、视口、选区和折叠状态都在这里：它们彼此耦合（折叠会重排行、选区依赖行号、
 * 悬停依赖时间戳位置），拆到多个类里只会让每次重画都要来回同步。界面类只负责按键与帧的
 * 编排。
 */

const SELECTION_STYLE = { reverse: true } as const;

interface MainFrame {
	readonly total: number;
	readonly rows: number;
	readonly window: ViewportWindow;
}

export class ConversationController {
	readonly transcript: Transcript;
	readonly #viewport = new Viewport();
	#main: MainFrame = { total: 0, rows: 1, window: { start: 0, following: true } };
	#rows: readonly Line[] = [];
	#blocks: readonly BlockSpan[] = [];
	#turns: readonly number[] = [];
	#turnPreviews: readonly string[] = [];
	#timestamps: readonly TimestampSpan[] = [];
	#selection: SelectionRegion | undefined;
	#selecting = false;
	#dragged = false;
	#selectedBlock: number | undefined;
	#copyIcon: { line: number; col: number } | undefined;
	#lastBlockClick: { id: number; at: number } | undefined;
	#hoverTurn: number | undefined;
	#hoverPreview = "";
	#hoverTimestamp: number | undefined;
	/** 悬停刻度所在的屏幕行：浮卡以它为竖直中心。 */
	#hoverRow: number | undefined;
	/** 当前帧里可见的 [Copy …] 标签区域，列已换算成屏幕列。 */
	#copyRegions: readonly { readonly row: number; readonly from: number; readonly to: number; readonly content: string }[] = [];

	constructor(width: number) {
		this.transcript = new Transcript(width);
	}

	setCwd(cwd: string): void {
		this.transcript.setCwd(cwd);
	}

	resize(width: number): void {
		this.transcript.resize(width);
	}

	userTurn(text: string, now = Date.now()): void {
		this.transcript.userTurn(text, now);
	}

	appendSystem(lines: readonly Line[], accent?: Parameters<Transcript["appendSystem"]>[1]): void {
		this.transcript.appendSystem(lines, accent);
	}

	handle(event: AgentEvent, now: number): void {
		this.transcript.handle(event, now);
	}

	clearRunning(): void {
		this.transcript.clearRunning();
	}

	/** 回合完成后在正文末尾补一行耗时。 */
	turnCompleted(elapsedMs: number, now = Date.now()): void {
		this.transcript.turnCompleted(elapsedMs, now);
	}

	/** 点中的 [Copy …] 标签对应的剪贴板内容；不在标签上时返回 undefined。 */
	copyTextAt(row: number, col: number): string | undefined {
		return this.#copyRegions.find(
			(region) => region.row === row && col >= region.from && col < region.to,
		)?.content;
	}

	get blocks(): readonly BlockSpan[] {
		return this.#blocks;
	}

	get turns(): readonly number[] {
		return this.#turns;
	}

	get window(): ViewportWindow {
		return this.#main.window;
	}

	get total(): number {
		return this.#main.total;
	}

	get height(): number {
		return this.#main.rows;
	}

	get selectedBlockId(): number | undefined {
		return this.#selectedBlock;
	}

	set selectedBlockId(id: number | undefined) {
		this.#selectedBlock = id;
	}

	get hoverTurnNumber(): number | undefined {
		if (this.#hoverTurn === undefined) return undefined;
		const index = this.#turns.indexOf(this.#hoverTurn);
		return index >= 0 ? index + 1 : 0;
	}

	get hoverPreview(): string {
		return this.#hoverPreview;
	}

	get hoverTimestamp(): number | undefined {
		return this.#hoverTimestamp;
	}

	blockText(id: number): string | undefined {
		return this.transcript.blockText(id);
	}

	blockMeta(id: number): string | undefined {
		return this.transcript.blockMeta(id);
	}

	toggleAll(): void {
		this.transcript.toggleAll();
	}

	toggleAllThinking(): void {
		this.transcript.toggleAllThinking();
	}

	/** 选中视口里的第一个块；没有块时保持 undefined。 */
	selectFirstVisible(): void {
		const block = this.#blocks.find((span) => span.start + span.height > this.#main.window.start);
		this.#selectedBlock = block?.id;
	}

	selectAdjacent(delta: number): void {
		const blocks = this.#blocks;
		if (blocks.length === 0) return;
		const current = blocks.findIndex((block) => block.id === this.#selectedBlock);
		const next =
			current < 0
				? delta > 0
					? 0
					: blocks.length - 1
				: Math.max(0, Math.min(blocks.length - 1, current + delta));
		const block = blocks[next];
		this.#selectedBlock = block.id;
		this.#ensureBlockVisible(block);
	}

	foldSelected(): void {
		if (this.#selectedBlock === undefined) return;
		this.toggleBlock(this.#selectedBlock);
	}

	changeSelectedFold(mode: "collapsed" | "expanded"): void {
		if (this.#selectedBlock === undefined) return;
		if (mode === "collapsed") this.transcript.collapse(this.#selectedBlock);
		else this.transcript.expand(this.#selectedBlock);
		this.#selection = undefined;
		this.#selecting = false;
		const block = this.#blocks.find((span) => span.id === this.#selectedBlock);
		if (block !== undefined) this.#ensureBlockVisible(block);
	}

	/** 双击一个块：可折叠的切换展开/收起，并保证它仍在视野里。 */
	toggleBlock(id: number): void {
		this.transcript.toggleFold(id);
		this.#selection = undefined;
		this.#selecting = false;
		const block = this.#blocks.find((span) => span.id === id);
		if (block === undefined) return;
		if (block.kind === "user") this.scrollTo(block.start);
		else this.#ensureBlockVisible(block);
	}

	/**
	 * 单击主区：选中块，300ms 内的第二次按下切换折叠。
	 * 返回 none/selected/toggled；调用方负责切焦点与重画。
	 */
	clickBlock(row: number): "none" | "selected" | "toggled" {
		const block = this.#blockAt(row);
		if (block === undefined) return "none";
		this.#selectedBlock = block.id;
		const now = Date.now();
		const last = this.#lastBlockClick;
		this.#lastBlockClick = { id: block.id, at: now };
		if (last !== undefined && last.id === block.id && now - last.at <= 300) {
			this.#lastBlockClick = undefined;
			this.toggleBlock(block.id);
			return "toggled";
		}
		return "selected";
	}

	blockAt(row: number): BlockSpan | undefined {
		return this.#blockAt(row);
	}

	/** 屏幕坐标落在哪一行文字的哪个字素簇上；落在竖线、轨道、滚动条上则不算。 */
	selectionPoint(col: number, row: number, entryWidth: number): SelectionPoint | undefined {
		if (row < 0 || row >= this.#main.rows) return undefined;

		const line = this.#main.window.start + row;
		if (line < 0 || line >= this.#rows.length) return undefined;

		const contentCol = col - OUTER_PAD;
		if (contentCol < 0 || contentCol >= entryWidth) return undefined;

		return { line, cell: cellIndexAtColumn(this.#rows[line], contentCol) };
	}

	beginSelection(point: SelectionPoint): void {
		this.#selection = { anchor: point, focus: point };
		this.#selecting = true;
		this.#dragged = false;
	}

	updateSelection(point: SelectionPoint): boolean {
		if (!this.#selecting || this.#selection === undefined) return false;
		// 没有离开起点的移动不算拖选：双击、原地抖动都不会带出一段文本
		const anchor = this.#selection.anchor;
		if (point.line === anchor.line && point.cell === anchor.cell) return false;
		this.#selection = { ...this.#selection, focus: point };
		this.#dragged = true;
		this.#lastBlockClick = undefined;
		return true;
	}

	/** 松开鼠标：拖过就返回选区文本，否则清掉端点。 */
	finishSelection(): string | undefined {
		this.#selecting = false;
		if (!this.#dragged) {
			this.#selection = undefined;
			return undefined;
		}
		return this.selectionText();
	}

	cancelSelection(): void {
		this.#selection = undefined;
		this.#selecting = false;
		this.#dragged = false;
	}

	get hasSelection(): boolean {
		return this.#selection !== undefined;
	}

	selectionText(): string | undefined {
		if (this.#selection === undefined) return undefined;
		const text = selectionText(this.#rows, this.#selection);
		return text.length > 0 ? text : undefined;
	}

	/** 选中块上的复制按钮是否被点到。 */
	copyIconHit(row: number, col: number): boolean {
		if (this.#copyIcon === undefined) return false;
		const line = this.#main.window.start + row;
		return line === this.#copyIcon.line && col === this.#copyIcon.col;
	}

	/** 轨道刻度或时间戳的悬停；返回是否发生了变化。刻度占两列，两列都是命中区。 */
	hoverAt(row: number, col: number, cols: number): boolean {
		const body = Math.max(16, cols - OUTER_PAD);
		const railStart = cols - RAIL_WIDTH;
		const onRail =
			railWidth({ width: body, turns: this.#turns.length }) > 0 &&
			col >= railStart &&
			col < railStart + RAIL_WIDTH &&
			row >= 0 &&
			row < this.#main.rows;

		let turn: number | undefined;
		let preview = "";
		if (onRail) {
			const cells = railCells(this.#main.rows, this.#turns, this.#main.window.start, this.#hoverTurn);
			turn = cells[row]?.target;
			const index = turn === undefined ? -1 : this.#turns.indexOf(turn);
			preview = index < 0 ? "" : (this.#turnPreviews[index] ?? "");
		}

		let timestamp: number | undefined;
		if (!onRail && row >= 0 && row < this.#main.rows) {
			const line = this.#main.window.start + row;
			const contentCol = col - OUTER_PAD;
			const span = this.#timestamps.find(
				(item) => item.row === line && contentCol >= item.col && contentCol < item.col + item.width,
			);
			timestamp = span?.createdAt;
		}

		if (turn === this.#hoverTurn && timestamp === this.#hoverTimestamp) return false;
		this.#hoverTurn = turn;
		this.#hoverPreview = preview;
		this.#hoverTimestamp = timestamp;
		this.#hoverRow = turn === undefined ? undefined : row;
		return true;
	}

	clearHover(): void {
		this.#hoverTurn = undefined;
		this.#hoverPreview = "";
		this.#hoverTimestamp = undefined;
		this.#hoverRow = undefined;
	}

	scrollTo(index: number): void {
		this.clearHover();
		this.#viewport.scrollTo(index, this.#main.total, this.#main.rows);
	}

	scrollBy(delta: number): void {
		this.clearHover();
		this.#viewport.scrollBy(delta, this.#main.total, this.#main.rows);
	}

	scrollPages(pages: number): void {
		this.clearHover();
		this.#viewport.scrollPages(pages, this.#main.total, this.#main.rows);
	}

	toTop(): void {
		this.clearHover();
		this.#viewport.toTop();
	}

	toEnd(): void {
		this.clearHover();
		this.#viewport.toEnd();
	}

	/** 跳到上一个或下一个回合的开头。 */
	jumpTurn(delta: number): void {
		if (this.#turns.length === 0) return;
		const top = this.#main.window.start;
		const target =
			delta > 0
				? this.#turns.find((row) => row > top)
				: [...this.#turns].reverse().find((row) => row < top);
		if (target !== undefined) this.scrollTo(target);
	}

	/** 主屏：会话区的可见窗口，右侧是轨道与滚动条。 */
	conversationRows(body: number, rows: number): readonly Line[] {
		const mainRows = Math.max(1, rows);
		const entryWidth = Math.max(1, body - GUTTER_WIDTH);
		this.transcript.resize(entryWidth);

		const view = this.transcript.view({ maxLiveRows: mainRows });
		this.#rows = view.rows;
		this.#blocks = view.blocks;
		this.#turns = view.turns;
		this.#turnPreviews = view.turnPreviews;
		this.#timestamps = view.timestamps;
		this.#copyIcon = undefined;

		const rail = railWidth({ width: body, turns: view.turns.length });
		const window = this.#viewport.window(view.rows.length, mainRows);
		this.#main = { total: view.rows.length, rows: mainRows, window };
		this.#copyRegions = view.copies
			.filter((copy) => copy.row >= window.start && copy.row < window.start + mainRows)
			.map((copy) => ({
				row: copy.row - window.start,
				from: copy.from + CONTENT_OFFSET,
				to: copy.to + CONTENT_OFFSET,
				content: copy.content,
			}));

		const visible = view.rows.slice(window.start, window.start + mainRows);
		while (visible.length < mainRows) visible.push(plain(""));

		const cells = rail > 0 ? railCells(mainRows, view.turns, window.start, this.#hoverTurn) : [];
		const filler = plain(" ".repeat(rail > 0 ? 0 : GUTTER_WIDTH - 1));
		const conversation = visible.map((line, index) => {
			const absolute = window.start + index;
			const range =
				this.#selection === undefined ? undefined : selectionRange(absolute, this.#selection, view.rows);
			const base =
				range === undefined ? line : highlightSelection(line, range.from, range.to, SELECTION_STYLE);
			const scroll = scrollbarCell(index, view.rows.length, mainRows, window.start);
			const entry = padLine(base, entryWidth);
			const gutter = rail === 0 ? concat(entry, filler) : appendRail(entry, cells[index]);
			return concat(plain(" ".repeat(OUTER_PAD)), gutter, [scroll]);
		});

		let frame = conversation;
		const selected =
			this.#selectedBlock === undefined
				? undefined
				: this.#blocks.find((block) => block.id === this.#selectedBlock);
		if (selected !== undefined) {
			const range = this.#selectionExtent(this.#blocks, selected);
			if (selected.mode === "collapsed" && range.height === selected.height) {
				// 收起的一行：底色加 ▸ 护栏，复制按钮内联在这行右端
				const banded = drawSelectionBand(conversation, range, window.start, entryWidth);
				const decorated = drawCopyIcon(banded, range, window.start, entryWidth, view.rows);
				this.#copyIcon = decorated.icon;
				frame = decorated.lines;
			} else {
				const boxed = drawSelectionBox(conversation, range, window.start, entryWidth);
				const decorated = drawCopyIcon(boxed, range, window.start, entryWidth, view.rows);
				this.#copyIcon = decorated.icon;
				frame = decorated.lines;
			}
		}
		return this.#overlayHover(frame, body + OUTER_PAD);
	}

	/** 选中范围：展开的组要把它整队成员行都框进来，其余块就是自身那一段。 */
	#selectionExtent(
		spans: readonly BlockSpan[],
		selected: BlockSpan,
	): BlockSpan {
		if (selected.kind === "group" && selected.mode === "expanded") {
			const position = spans.indexOf(selected);
			let end = selected.start + selected.height;
			for (let index = position + 1; index < spans.length; index += 1) {
				const next = spans[index];
				if (next.kind !== "tool" || next.start !== end) break;
				end = next.start + next.height;
			}
			return { ...selected, height: end - selected.start };
		}
		return selected;
	}

	/** 悬停的落点画在会话区里：轨道旁的预览浮卡、时间戳原地展开。 */
	#overlayHover(lines: readonly Line[], cols: number): readonly Line[] {
		let result = lines;
		const stamp = this.#hoverTimestamp;
		if (stamp !== undefined) {
			const start = this.#main.window.start;
			const end = start + this.#main.rows;
			const span = this.#timestamps.find(
				(item) => item.createdAt === stamp && item.row >= start && item.row < end,
			);
			if (span !== undefined && span.row - start < result.length) {
				const row = span.row - start;
				result = result.map((line, index) =>
					index === row ? expandTimestamp(line, OUTER_PAD + span.col, span.width, fullTimestamp(stamp)) : line,
				);
			}
		}
		if (this.#hoverTurn !== undefined && this.#hoverRow !== undefined) {
			const index = this.#turns.indexOf(this.#hoverTurn);
			if (index >= 0) {
				result = drawHoverCard(result, this.#hoverRow, cols, this.#turnPreviews[index] ?? "");
			}
		}
		return result;
	}

	#blockAt(row: number): BlockSpan | undefined {
		if (row < 0 || row >= this.#main.rows) return undefined;
		const line = this.#main.window.start + row;
		return this.#blocks.find((span) => line >= span.start && line < span.start + span.height);
	}

	#ensureBlockVisible(block: BlockSpan): void {
		const { start } = this.#main.window;
		const end = start + this.#main.rows;
		if (block.start < start || block.start + block.height > end) this.scrollTo(block.start);
	}
}
