import {
	LineEditor,
	pasteChipLabel,
	type ClipboardPort,
	type EditorRender,
	type KeyEvent,
	type Line,
	type Style,
} from "../../tui/index.ts";
import { BUILTIN_COMMANDS } from "./commands.ts";
import {
	detectAtContext,
	indexWorkspaceFiles,
	matchFiles,
	type AtContext,
	type FileEntry,
} from "./file-search.ts";
import {
	fileMenuRows,
	historyMenuRows,
	MAX_MENU_ROWS,
	MENU_CHROME_ROWS,
	slashMenuRows,
} from "./menu-view.ts";
import { matchSlashCommands, slashContext, type SlashCommand, type SlashContext } from "./slash-menu.ts";
import { PATH } from "./theme.ts";

/**
 * 输入区控制器。
 *
 * 把编辑器和两个下拉（`/` 命令、`@` 文件）放在一起：它们共享同一份草稿、光标位置和“关闭到
 * 下一次编辑”的状态，分在界面类里会让键处理与渲染各拿一半。这里只管输入区，不碰会话记录、
 * 权限面板或底部提示。
 */

export interface PromptCommand {
	readonly name: string;
	readonly description: string;
}

export interface PromptControllerOptions {
	/** 插件命令；自带命令由控制器补在前面。 */
	readonly commands: () => readonly PromptCommand[];
	/** 文件索引等异步状态变化后通知界面重画。 */
	readonly onChange: () => void;
}

type MenuKind = "slash" | "file" | "history";

export class PromptController {
	readonly editor: LineEditor;
	readonly #commands: () => readonly PromptCommand[];
	readonly #onChange: () => void;

	#slashIndex = 0;
	#slashQuery: string | undefined;
	#slashClosedFor: string | undefined;

	#fileIndex: readonly FileEntry[] = [];
	#fileIndexRoot: string | undefined;
	#fileIndexLoading = false;
	#fileIndexAt = 0;
	#fileIndexSelected = 0;
	#fileIndexKey: string | undefined;
	#fileDrillPrefix: string | undefined;
	#fileClosedFor: string | undefined;
	/** `@!` 用的清单：包含隐藏与被 .gitignore 忽略的文件 */
	#hiddenIndex: readonly FileEntry[] = [];
	#hiddenRoot: string | undefined;
	#hiddenLoading = false;
	#hiddenAt = 0;

	#historyOpen = false;
	#historySelected = 0;

	#menuKind: MenuKind | undefined;
	#menuTop = 0;
	#menuVisible = 0;
	#menuHover: number | undefined;
	#lastClick: { kind: MenuKind; index: number; at: number } | undefined;
	#editorElements: EditorRender["elements"] = [];
	#lastElementClick: { id: number; at: number } | undefined;

	constructor(options: PromptControllerOptions) {
		this.editor = new LineEditor();
		this.#commands = options.commands;
		this.#onChange = options.onChange;
	}

	get displayText(): string {
		return this.editor.displayText;
	}

	get menuVisible(): number {
		return this.#menuVisible;
	}

	render(width: number, maxRows: number, pasteStyle: Style, prompt: Line, placeholder?: string): EditorRender {
		const rendered = this.editor.render({ width, prompt, maxRows, pasteStyle, placeholder });
		this.#editorElements = rendered.elements;
		return rendered;
	}

	/** 输入区单击：落在粘贴 chip 上时记录位置，300ms 内的第二下把它展开。 */
	clickEditor(editorRow: number, editorCol: number): void {
		if (editorRow < 0 || editorCol < 0) {
			this.#lastElementClick = undefined;
			return;
		}

		const element = this.#editorElements.find(
			(item) => item.row === editorRow && editorCol >= item.col && editorCol < item.col + item.width,
		);
		if (element === undefined) {
			this.#lastElementClick = undefined;
			return;
		}

		const now = Date.now();
		const last = this.#lastElementClick;
		this.#lastElementClick = { id: element.id, at: now };
		if (last !== undefined && last.id === element.id && now - last.at <= 300) {
			this.#lastElementClick = undefined;
			this.editor.expandPasteElement(element.id);
		}
	}

	/** 当前打开的菜单类型；提示条与布局用它。 */
	menuKind(): MenuKind | undefined {
		if (this.#historyState() !== undefined) return "history";
		if (this.#slashState() !== undefined) return "slash";
		if (this.#fileState() !== undefined) return "file";
		return undefined;
	}

	/**
	 * 空输入时按 Up：把已提交的历史铺成面板。
	 *
	 * 面板只负责挑选，不覆盖草稿；选中后回车才写回输入框，使用者还能接着改。
	 */
	openHistory(): boolean {
		if (!this.editor.isEmpty || this.editor.historyEntries().length === 0) return false;
		this.#historyOpen = true;
		this.#historySelected = 0;
		return true;
	}

	closeHistory(): void {
		this.#historyOpen = false;
	}

	#historyState(): readonly string[] | undefined {
		if (!this.#historyOpen) return undefined;
		const entries = [...this.editor.historyEntries()].reverse();
		if (entries.length === 0) {
			this.#historyOpen = false;
			return undefined;
		}
		this.#historySelected = Math.max(0, Math.min(entries.length - 1, this.#historySelected));
		return entries;
	}

	#acceptHistory(): void {
		const entries = this.#historyState();
		const text = entries?.[this.#historySelected];
		this.#historyOpen = false;
		if (text !== undefined) this.editor.insert(text);
	}

	hasMenu(): boolean {
		return this.menuKind() !== undefined;
	}

	/** 鼠标悬停的候选下标；菜单换类型时作废。 */
	get menuHover(): number | undefined {
		return this.#menuHover;
	}

	setMenuHover(index: number | undefined): void {
		this.#menuHover = index;
	}

	/** 渲染下拉并记下窗口位置；没有候选时返回空数组。 */
	menuRows(width: number, terminalRows: number): readonly Line[] {
		const limit = Math.max(1, Math.min(MAX_MENU_ROWS, terminalRows - 10));
		const history = this.#historyState();
		if (history !== undefined) {
			if (this.#menuKind !== "history") this.#menuHover = undefined;
			const layout = historyMenuRows(
				history,
				this.#historySelected,
				width,
				limit,
				this.#menuHover,
			);
			this.#menuKind = "history";
			this.#menuTop = layout.top;
			this.#menuVisible = layout.visible;
			return layout.rows;
		}

		const slash = this.#slashState();
		if (slash !== undefined) {
			if (this.#menuKind !== "slash") this.#menuHover = undefined;
			const layout = slashMenuRows(
				slash.items,
				this.#slashIndex,
				width,
				limit,
				slash.context.query,
				this.#menuHover,
			);
			this.#menuKind = "slash";
			this.#menuTop = layout.top;
			this.#menuVisible = layout.visible;
			return layout.rows;
		}

		const file = this.#slashState() === undefined ? this.#fileState() : undefined;
		if (file !== undefined) {
			if (this.#menuKind !== "file") this.#menuHover = undefined;
				const hint = `${file.items.length}/${file.total}`;
			const layout = fileMenuRows(
				file.items,
				this.#fileIndexSelected,
				width,
				limit,
				hint,
				file.context.query,
				this.#menuHover,
			);
			this.#menuKind = "file";
			this.#menuTop = layout.top;
			this.#menuVisible = layout.visible;
			return layout.rows;
		}

		this.#menuKind = undefined;
		this.#menuHover = undefined;
		this.#menuVisible = 0;
		return [];
	}

	/** 鼠标落在下拉第 relativeRow 行时对应的候选项；面板第一行是框线，先扣掉。 */
	menuIndexAt(relativeRow: number): { readonly kind: MenuKind; readonly index: number } | undefined {
		if (this.#menuKind === undefined) return undefined;
		const itemRow = relativeRow - MENU_CHROME_ROWS;
		if (itemRow < 0 || itemRow >= this.#menuVisible) return undefined;
		return { kind: this.#menuKind, index: this.#menuTop + itemRow };
	}

	/** 单击选中；300ms 内的第二下接受该项。返回是否命中下拉。 */
	clickMenu(relativeRow: number): boolean {
		const hit = this.menuIndexAt(relativeRow);
		if (hit === undefined) return false;
		this.#selectMenu(hit.kind, hit.index);

		const now = Date.now();
		const last = this.#lastClick;
		this.#lastClick = { ...hit, at: now };
		if (last !== undefined && last.kind === hit.kind && last.index === hit.index && now - last.at <= 300) {
			this.#lastClick = undefined;
			this.#acceptMenu(hit.kind, hit.index, false);
		}
		return true;
	}

	/** 滚轮移动下拉选择，夹在两端。 */
	scrollMenu(delta: number): void {
		const kind = this.menuKind();
		if (kind === "slash") {
			const state = this.#slashState();
			if (state !== undefined) {
				this.#slashIndex = Math.max(0, Math.min(state.items.length - 1, this.#slashIndex + delta));
			}
		} else if (kind === "file") {
			const state = this.#fileState();
			if (state !== undefined) {
				this.#fileIndexSelected = Math.max(0, Math.min(state.items.length - 1, this.#fileIndexSelected + delta));
			}
		} else if (kind === "history") {
			const state = this.#historyState();
			if (state !== undefined) {
				this.#historySelected = Math.max(0, Math.min(state.length - 1, this.#historySelected + delta));
			}
		}
	}

	/**
	 * 下拉打开时的按键。
	 *
	 * 返回 true 表示已经处理；返回 false 时调用方继续走普通输入逻辑（斜杠命令已经完整打出，
	 * 这一下 Enter 应该发送）。
	 */
	handleMenuKey(event: Extract<KeyEvent, { type: "key" }>): boolean {
		const history = this.#historyState();
		if (history !== undefined) {
			if (event.name === "up" || event.name === "ctrl-p") {
				this.#historySelected = Math.max(0, this.#historySelected - 1);
				return true;
			}
			if (event.name === "down" || event.name === "ctrl-n") {
				this.#historySelected = Math.min(history.length - 1, this.#historySelected + 1);
				return true;
			}
			if (event.name === "enter" || event.name === "tab") {
				this.#acceptHistory();
				return true;
			}
			if (event.name === "escape" || event.name === "ctrl-c") {
				this.#historyOpen = false;
				return true;
			}
			if (event.name === "backspace" || event.name === "delete") {
				this.#historyOpen = false;
				return true;
			}
			return false;
		}

		const slash = this.#slashState();
		if (slash !== undefined) {
			if (event.name === "up" || event.name === "ctrl-p") return this.#moveSlash(-1);
			if (event.name === "down" || event.name === "ctrl-n") return this.#moveSlash(1);
			if (event.name === "pageup") return this.#scrollSlash(-MAX_MENU_ROWS);
			if (event.name === "pagedown") return this.#scrollSlash(MAX_MENU_ROWS);
			if (event.name === "tab") {
				const item = slash.items[this.#slashIndex];
				if (item !== undefined) this.#acceptSlash(item, slash.context);
				return true;
			}
			if (event.name === "escape") {
				this.#slashClosedFor = this.editor.displayText;
				return true;
			}
			if (event.name === "enter") {
				const item = slash.items[this.#slashIndex];
				if (item === undefined) return true;
				const token = this.editor.displayText.slice(1, slash.context.tokenLength);
				if (token === item.name) {
					// 已经完整打出命令：关闭下拉，让调用方发送
					this.#slashClosedFor = this.editor.displayText;
					return false;
				}
				this.#acceptSlash(item, slash.context);
				return true;
			}
		}

		const file = slash === undefined ? this.#fileState() : undefined;
		if (file === undefined) return false;
		if (event.name === "up" || event.name === "ctrl-p") return this.#moveFile(-1);
		if (event.name === "down" || event.name === "ctrl-n") return this.#moveFile(1);
		if (event.name === "pageup") return this.#scrollFile(-MAX_MENU_ROWS);
		if (event.name === "pagedown") return this.#scrollFile(MAX_MENU_ROWS);
		if (event.name === "tab" || event.name === "enter") {
			const item = file.items[this.#fileIndexSelected];
			if (item !== undefined) this.#acceptFile(item, file.context, false);
			return true;
		}
		if (event.name === "right") {
			const item = file.items[this.#fileIndexSelected];
			if (item !== undefined) this.#acceptFile(item, file.context, true);
			return true;
		}
		if (event.name === "escape") {
			this.#fileClosedFor = this.editor.displayText;
			return true;
		}
		return false;
	}

	/** 往输入框插入普通文本。输入即视为离开历史面板。 */
	insertText(text: string): void {
		this.#historyOpen = false;
		this.editor.insert(text);
	}

	/** 从剪贴板粘贴；没有可粘贴文本时返回 false。 */
	pasteFromClipboard(clipboard: ClipboardPort, inline: boolean): boolean {
		const text = clipboard.readText();
		if (text === undefined || text.trim().length === 0) return false;
		this.insertPaste(text, inline);
		return true;
	}

	/** 粘贴分流：重粘贴展开 chip，多行/大文本折成 chip，其余内联。 */
	insertPaste(text: string, inline: boolean): void {
		this.#historyOpen = false;
		const normalized = text.replaceAll(/\r\n?/g, "\n");
		if (normalized.length === 0) return;

		if (!inline && this.editor.expandPasteAtCursor(normalized)) return;
		const label = inline ? undefined : pasteChipLabel(normalized);
		if (label === undefined) this.editor.insert(normalized);
		else this.editor.insertElement(normalized, label);
	}

	/** 异步建立文件清单；同一根目录 30 秒内不重复扫描。 */
	loadFileIndex(root: string): void {
		if (this.#fileIndexLoading && this.#fileIndexRoot === root) return;
		if (this.#fileIndexRoot === root && Date.now() - this.#fileIndexAt < 30_000) return;

		this.#fileIndexRoot = root;
		this.#fileIndexLoading = true;
		this.#fileIndexAt = Date.now();
		void indexWorkspaceFiles(root)
			.then((entries) => {
				if (this.#fileIndexRoot !== root) return;
				this.#fileIndex = entries;
				this.#fileIndexLoading = false;
				this.#onChange();
			})
			.catch(() => {
				if (this.#fileIndexRoot !== root) return;
				this.#fileIndexLoading = false;
				this.#onChange();
			});
	}

	#slashCatalog(): readonly SlashCommand[] {
		const builtins: SlashCommand[] = BUILTIN_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
			tag: "built-in",
			insertText: `/${command.name}${command.takesArgs === true ? " " : ""}`,
		}));
		const names = new Set(builtins.map((command) => command.name));
		const plugins: SlashCommand[] = this.#commands()
			.filter((command) => !names.has(command.name))
			.map((command) => ({
				name: command.name,
				description: command.description,
				tag: "plugin",
				insertText: `/${command.name} `,
			}));
		return [...builtins, ...plugins];
	}

	#slashState(): { context: SlashContext; items: readonly SlashCommand[] } | undefined {
		const text = this.editor.displayText;
		if (this.#slashClosedFor !== undefined && this.#slashClosedFor !== text) this.#slashClosedFor = undefined;
		if (this.#slashClosedFor === text) return undefined;

		const context = slashContext(text, this.editor.displayBeforeCursor.length);
		if (context === undefined) {
			this.#slashQuery = undefined;
			return undefined;
		}

		const items = matchSlashCommands(this.#slashCatalog(), context.query);
		if (items.length === 0) return undefined;
		if (context.query !== this.#slashQuery) {
			this.#slashQuery = context.query;
			this.#slashIndex = 0;
		}
		this.#slashIndex = Math.max(0, Math.min(items.length - 1, this.#slashIndex));
		return { context, items };
	}

	#moveSlash(delta: number): boolean {
		const state = this.#slashState();
		if (state === undefined) return false;
		const count = state.items.length;
		this.#slashIndex = (this.#slashIndex + delta + count) % count;
		return true;
	}

	#scrollSlash(delta: number): boolean {
		const state = this.#slashState();
		if (state === undefined) return false;
		this.#slashIndex = Math.max(0, Math.min(state.items.length - 1, this.#slashIndex + delta));
		return true;
	}

	#acceptSlash(item: SlashCommand, context: SlashContext): void {
		this.editor.replacePrefix(context.tokenLength, item.insertText);
		// 补全后先收起下拉；继续输入会按新文本重新判断
		this.#slashClosedFor = this.editor.displayText;
		this.#slashQuery = undefined;
	}

	#fileState(): { context: AtContext; items: readonly FileEntry[]; total: number } | undefined {
		const text = this.editor.displayText;
		if (this.#fileClosedFor !== undefined && this.#fileClosedFor !== text) this.#fileClosedFor = undefined;
		if (this.#fileClosedFor === text) return undefined;

		const context = detectAtContext(text, this.editor.displayBeforeCursor.length, this.#fileDrillPrefix);
		if (context === undefined) {
			this.#fileDrillPrefix = undefined;
			this.#fileIndexKey = undefined;
			return undefined;
		}
		// 文本已经不再以刚钻入的目录开头：锚点失效，后面的空白恢复成词尾
		const query = context.hidden ? context.query.slice(1) : context.query;
		if (this.#fileDrillPrefix !== undefined && !query.startsWith(this.#fileDrillPrefix)) {
			this.#fileDrillPrefix = undefined;
		}

		// `@!` 用另一份包含被忽略文件的清单；第一次用到时才建立
		if (context.hidden) {
			this.#loadHiddenIndex();
			if (this.#hiddenIndex.length === 0) {
				this.#fileIndexKey = undefined;
				return undefined;
			}
		}

		const index = context.hidden ? this.#hiddenIndex : this.#fileIndex;
		if (index.length === 0) {
			this.#fileIndexKey = undefined;
			return undefined;
		}

		const items = matchFiles(index, context.query);
		if (items.length === 0) return undefined;

		const key = `${context.hidden ? "hidden" : "normal"}:${context.start}:${context.end}:${context.query}`;
		if (key !== this.#fileIndexKey) {
			this.#fileIndexKey = key;
			this.#fileIndexSelected = 0;
		}
		this.#fileIndexSelected = Math.max(0, Math.min(items.length - 1, this.#fileIndexSelected));
		return { context, items, total: index.length };
	}

	/** 隐藏文件清单按需建立；同一根目录 30 秒内不重复扫描。 */
	#loadHiddenIndex(): void {
		const root = this.#fileIndexRoot;
		if (root === undefined || this.#hiddenLoading) return;
		if (this.#hiddenRoot === root && Date.now() - this.#hiddenAt < 30_000) return;

		this.#hiddenRoot = root;
		this.#hiddenLoading = true;
		this.#hiddenAt = Date.now();
		void indexWorkspaceFiles(root, { includeIgnored: true })
			.then((entries) => {
				if (this.#hiddenRoot !== root) return;
				this.#hiddenIndex = entries;
				this.#hiddenLoading = false;
				this.#onChange();
			})
			.catch(() => {
				if (this.#hiddenRoot !== root) return;
				this.#hiddenLoading = false;
				this.#onChange();
			});
	}

	#moveFile(delta: number): boolean {
		const state = this.#fileState();
		if (state === undefined) return false;
		const count = state.items.length;
		this.#fileIndexSelected = (this.#fileIndexSelected + delta + count) % count;
		return true;
	}

	#scrollFile(delta: number): boolean {
		const state = this.#fileState();
		if (state === undefined) return false;
		this.#fileIndexSelected = Math.max(0, Math.min(state.items.length - 1, this.#fileIndexSelected + delta));
		return true;
	}

	/**
	 * 接受一个文件结果。
	 *
	 * 目录在目录模式（查询以 `/` 结尾）或按右方向键时补成 `@dir/` 并保持下拉；其余情况补成
	 * `@path ` 后收起。
	 */
	#acceptFile(item: FileEntry, context: AtContext, drill: boolean): void {
		const directory = item.kind === "directory";
		const drillDown = directory && (drill || context.query.endsWith("/"));
		if (drillDown) {
			// 钻进目录时保留可继续编辑的查询文本，不折成整体
			const replacement = `@${item.path}/`;
			if (!this.editor.replaceDisplayRange(context.start, context.end, replacement)) return;
			this.#fileIndexKey = undefined;
			this.#fileDrillPrefix = `${item.path}/`;
			this.#fileClosedFor = undefined;
			return;
		}

		// 选定的文件是一个整体：退格一次删掉整段引用，光标不会停在路径中间
		const reference = `@${item.path}`;
		if (
			!this.editor.replaceDisplayRangeElement(
				context.start,
				context.end,
				reference,
				reference,
				PATH,
				" ",
			)
		) {
			return;
		}
		this.#fileIndexKey = undefined;
		this.#fileDrillPrefix = undefined;
		this.#fileClosedFor = this.editor.displayText;
	}

	#selectMenu(kind: MenuKind, index: number): void {
		if (kind === "history") {
			const state = this.#historyState();
			if (state !== undefined) {
				this.#historySelected = Math.max(0, Math.min(state.length - 1, index));
			}
			return;
		}
		if (kind === "slash") {
			const state = this.#slashState();
			if (state !== undefined) this.#slashIndex = Math.max(0, Math.min(state.items.length - 1, index));
			return;
		}
		const state = this.#fileState();
		if (state !== undefined) this.#fileIndexSelected = Math.max(0, Math.min(state.items.length - 1, index));
	}

	#acceptMenu(kind: MenuKind, index: number, drill: boolean): void {
		if (kind === "history") {
			const state = this.#historyState();
			if (state !== undefined) {
				this.#historySelected = Math.max(0, Math.min(state.length - 1, index));
				this.#acceptHistory();
			}
			return;
		}
		if (kind === "slash") {
			const state = this.#slashState();
			const item = state?.items[index];
			if (state !== undefined && item !== undefined) this.#acceptSlash(item, state.context);
			return;
		}
		const state = this.#fileState();
		const item = state?.items[index];
		if (state !== undefined && item !== undefined) this.#acceptFile(item, state.context, drill);
	}
}
