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
	drawHoverBand,
	drawHoverCard,
	drawSelectionBand,
	drawSelectionBox,
	expandTimestamp,
} from "./conversation-view.ts";
import { GUTTER_WIDTH, CONTENT_OFFSET, OUTER_PAD } from "./layout.ts";
import { appendRail, railCells, railWidth, RAIL_WIDTH } from "./rail.ts";
import { scrollbarCell } from "./scrollbar.ts";
import { fullTimestamp } from "./session-format.ts";
import { DIM } from "./theme.ts";
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

/** 会话内容上下各留一行：贴着屏幕边缘读起来太挤，也给跟随指示留出落点。 */
const SCROLLBACK_PAD = 1;

/** 少于这么多行时不放留白：内容本身已经不够用。 */
const MIN_ROWS_FOR_PAD = 3;

/** 滚动指示符号。 */
const FOLLOW_DOWN = "▼";
const FOLLOW_UP = "▲";

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
	#lastBlockClick: { id: number; at: number } | undefined;
	#hoverTurn: number | undefined;
	#hoverPreview = "";
	#hoverTimestamp: number | undefined;
	/** 悬停刻度所在的屏幕行：浮卡以它为竖直中心。 */
	#hoverRow: number | undefined;
	/** 当前帧里悬停的收起块；只影响那一行的底色与折叠指示符。 */
	#hoverBlock: number | undefined;
	/** 当前帧里可见的 [Copy …] 标签区域，列已换算成屏幕列。 */
	#copyRegions: readonly { readonly row: number; readonly from: number; readonly to: number; readonly content: string }[] = [];
	/** 内容区上下的留白行数。 */
	#padTop = 0;
	#padBottom = 0;
	/** 这一帧滚动条是否画出来：轨道出现时，滚动条让位。 */
	#scrollbarShown = false;

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

	/** 接续旧会话：把已经发生过的对话一次性铺进记录。 */
	loadHistory(items: Parameters<Transcript["appendHistory"]>[0]): void {
		this.transcript.appendHistory(items);
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
		const content = this.toContentRow(row);
		if (content === undefined) return undefined;
		return this.#copyRegions.find(
			(region) => region.row === content && col >= region.from && col < region.to,
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

	/** 内容区本身的高度，不含上下留白。 */
	get height(): number {
		return this.#main.rows;
	}

	/** 会话区里还没有任何内容：首屏用它决定要不要摆入口卡片。 */
	get isEmpty(): boolean {
		return this.#blocks.length === 0 && this.#rows.length === 0;
	}

	/** 会话区在屏幕上占的总行数：内容加上下留白。 */
	get areaHeight(): number {
		return this.#padTop + this.#main.rows + this.#padBottom;
	}

	/** 内容首行在屏幕上的行号；鼠标行号换算要用它。 */
	get topPad(): number {
		return this.#padTop;
	}

	/** 这一帧有没有画滚动条。轨道出现时滚动条隐藏。 */
	get scrollbarShown(): boolean {
		return this.#scrollbarShown;
	}

	/** 屏幕行号换算成内容行号；落在上下留白或屏幕外时返回 undefined。 */
	toContentRow(row: number): number | undefined {
		const content = row - this.#padTop;
		return content >= 0 && content < this.#main.rows ? content : undefined;
	}

	/**
	 * 上下留白里的跟随指示。
	 *
	 * 上面还有内容时顶上画 ▲，下面还有内容时底下画 ▼；点一下回到那一端。
	 */
	padActionAt(row: number): "top" | "bottom" | undefined {
		if (row < 0 || row >= this.areaHeight) return undefined;
		if (row < this.#padTop) {
			return this.#main.window.start > 0 ? "top" : undefined;
		}
		if (row >= this.#padTop + this.#main.rows) {
			return this.#main.window.start + this.#main.rows < this.#main.total ? "bottom" : undefined;
		}
		return undefined;
	}

	/** 点中选中框右上角的关闭按钮时返回 true。 */
	selectionCloseAt(row: number, col: number, entryWidth: number): boolean {
		if (this.#selectedBlock === undefined) return false;
		const block = this.#blocks.find((item) => item.id === this.#selectedBlock);
		if (block === undefined) return false;
		const range = this.#selectionExtent(this.#blocks, block);
		// 块顶端被视口裁掉时没有角，也就没有关闭按钮
		if (range.start < this.#main.window.start) return false;
		const top = range.start - this.#main.window.start + this.#padTop - 1;
		const right = OUTER_PAD + entryWidth;
		return row === top && col === right;
	}

	/** 取消块选中：点关闭按钮或重新开始一轮时用。 */
	clearSelectedBlock(): void {
		this.#selectedBlock = undefined;
		this.#lastBlockClick = undefined;
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

	blockPrimary(id: number): string | undefined {
		return this.transcript.blockPrimary(id);
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

	/** 切换选中回答的 markdown 源码/渲染视图；不是回答块时返回 false。 */
	toggleSelectedRaw(): boolean {
		if (this.#selectedBlock === undefined) return false;
		return this.transcript.toggleRaw(this.#selectedBlock);
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
		const contentRow = this.toContentRow(row);
		if (contentRow === undefined) return undefined;

		const line = this.#main.window.start + contentRow;
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

	/** 轨道刻度、时间戳或收起行的悬停；返回是否发生了变化。 */
	hoverAt(row: number, col: number, cols: number): boolean {
		const contentRow = this.toContentRow(row);
		const body = Math.max(16, cols - OUTER_PAD);
		// 轨道占右侧两列（滚动条左边），两列都是命中区
		const railStart = cols - GUTTER_WIDTH;
		const onRail =
			contentRow !== undefined &&
			railWidth({ width: body, turns: this.#turns.length }) > 0 &&
			col >= railStart &&
			col < railStart + RAIL_WIDTH;

		let turn: number | undefined;
		let preview = "";
		if (onRail && contentRow !== undefined) {
			const cells = railCells(this.#main.rows, this.#turns, this.#main.window.start, this.#hoverTurn);
			turn = cells[contentRow]?.target;
			const index = turn === undefined ? -1 : this.#turns.indexOf(turn);
			preview = index < 0 ? "" : (this.#turnPreviews[index] ?? "");
		}

		let timestamp: number | undefined;
		if (!onRail && contentRow !== undefined) {
			const line = this.#main.window.start + contentRow;
			const contentCol = col - OUTER_PAD;
			const span = this.#timestamps.find(
				(item) => item.row === line && contentCol >= item.col && contentCol < item.col + item.width,
			);
			timestamp = span?.createdAt;
		}

		// 收起行与展开组的组头悬停时换成折叠指示符；用户消息与展开的正文不参与
		let blockId: number | undefined;
		if (!onRail && contentRow !== undefined) {
			const block = this.#blockAtContent(contentRow);
			if (
				block !== undefined &&
				(block.kind === "group" ||
					((block.kind === "tool" || block.kind === "thinking") && block.mode === "collapsed"))
			) {
				blockId = block.id;
			}
		}

		if (
			turn === this.#hoverTurn &&
			timestamp === this.#hoverTimestamp &&
			blockId === this.#hoverBlock
		) {
			return false;
		}
		this.#hoverTurn = turn;
		this.#hoverPreview = preview;
		this.#hoverTimestamp = timestamp;
		this.#hoverBlock = blockId;
		this.#hoverRow = turn === undefined ? undefined : row;
		return true;
	}

	clearHover(): void {
		this.#hoverTurn = undefined;
		this.#hoverPreview = "";
		this.#hoverTimestamp = undefined;
		this.#hoverBlock = undefined;
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

	/**
	 * 主屏：会话区的可见窗口，右侧是轨道与滚动条。
	 *
	 * 内容上下各留一行；被视口裁掉一端时，留白里画跟随指示。轨道出现时滚动条让位：
	 * 两者都在回答「看到哪儿了」，同时画只会占用正文列。
	 */
	conversationRows(body: number, rows: number, showSelection = true): readonly Line[] {
		const pad = rows >= MIN_ROWS_FOR_PAD ? SCROLLBACK_PAD : 0;
		this.#padTop = pad;
		this.#padBottom = pad;
		const mainRows = Math.max(1, rows - pad * 2);
		const entryWidth = Math.max(1, body - GUTTER_WIDTH);
		this.transcript.resize(entryWidth);

		const view = this.transcript.view({ maxLiveRows: mainRows });
		this.#rows = view.rows;
		this.#blocks = view.blocks;
		this.#turns = view.turns;
		this.#turnPreviews = view.turnPreviews;
		this.#timestamps = view.timestamps;

		const rail = railWidth({ width: body, turns: view.turns.length });
		const window = this.#viewport.window(view.rows.length, mainRows);
		this.#main = { total: view.rows.length, rows: mainRows, window };
		this.#scrollbarShown = rail === 0 && view.rows.length > mainRows;
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
			const scroll: Line = rail > 0 ? plain(" ") : [scrollbarCell(index, view.rows.length, mainRows, window.start)];
			const entry = padLine(base, entryWidth);
			const gutter = rail === 0 ? concat(entry, filler) : appendRail(entry, cells[index]);
			return concat(plain(" ".repeat(OUTER_PAD)), gutter, scroll);
		});

		const width = body + OUTER_PAD;
		let frame: readonly Line[] = [
			...(pad > 0 ? [this.#padRow(width, window.start > 0 ? FOLLOW_UP : undefined)] : []),
			...conversation,
			...(pad > 0 ? [this.#padRow(width, window.start + mainRows < view.rows.length ? FOLLOW_DOWN : undefined)] : []),
		];
		// 极端尺寸下仍要正好占满分给会话区的行数，后续布局才不会错位
		while (frame.length < rows) frame = [...frame, plain("")];
		frame = frame.slice(0, rows);

		frame = this.#applyHover(frame, view.blocks, entryWidth);
		const selected =
			!showSelection || this.#selectedBlock === undefined
				? undefined
				: this.#blocks.find((block) => block.id === this.#selectedBlock);
		if (selected !== undefined) {
			const range = this.#selectionExtent(this.#blocks, selected);
			const decoration = { topPad: this.#padTop, contentRows: mainRows };
			// 收起的一行铺高亮底色并画 ▸ 护栏；所有选中块都再画一圈 ┌┐ 框
			if (selected.mode === "collapsed" && range.height === selected.height) {
				frame = drawSelectionBand(frame, range, window.start, entryWidth, decoration);
			}
			frame = drawSelectionBox(frame, range, window.start, entryWidth, decoration);
		}
		return this.#overlayHover(frame, body + OUTER_PAD);
	}

	/** 留白里的一行；有指示符号时居中放。 */
	#padRow(width: number, glyph: string | undefined): Line {
		if (glyph === undefined) return plain("");
		const column = Math.max(0, Math.floor((width - 1) / 2));
		return concat(plain(" ".repeat(column)), [{ text: glyph, style: DIM }]);
	}

	/** 悬停的收起行铺一层浅底色；选中的块不再重复画。 */
	#applyHover(lines: readonly Line[], blocks: readonly BlockSpan[], entryWidth: number): readonly Line[] {
		const id = this.#hoverBlock;
		if (id === undefined || id === this.#selectedBlock) return lines;
		const block = blocks.find((item) => item.id === id);
		if (block === undefined) return lines;
		return drawHoverBand(lines, block, this.#main.window.start, entryWidth, {
			topPad: this.#padTop,
			contentRows: this.#main.rows,
		});
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
			const row = span === undefined ? undefined : span.row - start + this.#padTop;
			if (span !== undefined && row !== undefined && row >= 0 && row < result.length) {
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
		const contentRow = this.toContentRow(row);
		return contentRow === undefined ? undefined : this.#blockAtContent(contentRow);
	}

	#blockAtContent(contentRow: number): BlockSpan | undefined {
		if (contentRow < 0 || contentRow >= this.#main.rows) return undefined;
		const line = this.#main.window.start + contentRow;
		return this.#blocks.find((span) => line >= span.start && line < span.start + span.height);
	}

	#ensureBlockVisible(block: BlockSpan): void {
		const { start } = this.#main.window;
		const end = start + this.#main.rows;
		if (block.start < start || block.start + block.height > end) this.scrollTo(block.start);
	}
}
