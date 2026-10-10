import { codePointWidth, softWrapRows } from './layout.ts';

/**
 * 输入行编辑器:光标、历史与文本编辑。
 *
 * 设计意图:纯状态机、不碰终端;文本按码点维护,避免拆断代理对。
 * 候选(斜杠命令、@ 文件、子菜单参数)一律不在这里算——菜单由应用层统一管,
 * 编辑器只报出「文本 + 光标」,免得同一套补全规则在两层各长一份。
 */
export class InputEditor {
  private chars: string[] = [];
  private cursorIndex = 0;
  private history: string[] = [];
  private historyPos: number | null = null;
  private draftChars: string[] = [];
  /** 软折行宽度(显示列),由视图层在渲染时同步;未设置时 ↑↓ 按逻辑行移动。 */
  private wrapWidth: number | undefined;

  get text(): string {
    return this.chars.join('');
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  /** 光标是否在最末尾:行尾的灰色预选只在此时刻显示与接受。 */
  get cursorAtEnd(): boolean {
    return this.cursorIndex === this.chars.length;
  }

  /** 插入可打印文本(控制字符被忽略,换行由 insertNewline / insertRaw 处理)。 */
  insert(text: string): void {
    for (const char of text) {
      if ((char.codePointAt(0) ?? 0) < 32) {
        continue;
      }
      this.chars.splice(this.cursorIndex, 0, char);
      this.cursorIndex += 1;
    }
    this.afterEdit();
  }

  /** 粘贴插入:整段一次性放入,保留换行;返回本次粘贴的行数。 */
  insertRaw(text: string): number {
    const incoming = [...text];
    if (incoming.length === 0) {
      return 0;
    }
    const before = this.chars.slice(0, this.cursorIndex);
    const after = this.chars.slice(this.cursorIndex);
    this.chars = [...before, ...incoming, ...after];
    this.cursorIndex += incoming.length;
    this.afterEdit();
    return incoming.filter((char) => char === '\n').length + 1;
  }

  insertNewline(): void {
    this.chars.splice(this.cursorIndex, 0, '\n');
    this.cursorIndex += 1;
    this.afterEdit();
  }

  backspace(): boolean {
    if (this.cursorIndex === 0) {
      return false;
    }
    this.chars.splice(this.cursorIndex - 1, 1);
    this.cursorIndex -= 1;
    this.afterEdit();
    return true;
  }

  deleteForward(): boolean {
    if (this.cursorIndex >= this.chars.length) {
      return false;
    }
    this.chars.splice(this.cursorIndex, 1);
    this.afterEdit();
    return true;
  }

  /** 向前删词(以空格分隔)。 */
  deleteWordBackward(): boolean {
    if (this.cursorIndex === 0) {
      return false;
    }
    let index = this.cursorIndex;
    while (index > 0 && this.chars[index - 1] === ' ') {
      index -= 1;
    }
    while (index > 0 && this.chars[index - 1] !== ' ') {
      index -= 1;
    }
    this.chars.splice(index, this.cursorIndex - index);
    this.cursorIndex = index;
    this.afterEdit();
    return true;
  }

  /** 同步软折行宽度(视图层渲染时调用);影响 ↑↓ 的移动粒度。 */
  setWrapWidth(width: number): void {
    this.wrapWidth = Math.max(0, width);
  }

  /** 软折行后的视觉行区间([start, end) 为全文码点下标)。 */
  private visualRows(): { start: number; end: number }[] {
    const width = this.wrapWidth ?? 0;
    const rows: { start: number; end: number }[] = [];
    let lineStart = 0;
    for (const raw of this.text.split('\n')) {
      const lineLength = [...raw].length;
      if (width <= 0) {
        rows.push({ start: lineStart, end: lineStart + lineLength });
      } else {
        for (const row of softWrapRows(raw, width)) {
          rows.push({ start: lineStart + row.start, end: lineStart + row.start + [...row.text].length });
        }
      }
      lineStart += lineLength + 1;
    }
    return rows;
  }

  /** 光标所在的视觉行下标;光标在文本末尾时取最后一个视觉行。 */
  private currentVisualRow(rows: readonly { start: number; end: number }[]): number {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]!.start <= this.cursorIndex) {
        return index;
      }
    }
    return 0;
  }

  /** 光标在视觉行内的显示列宽。 */
  private rowColumn(row: { start: number; end: number }): number {
    let width = 0;
    for (let index = row.start; index < this.cursorIndex && index < row.end; index += 1) {
      width += codePointWidth(this.chars[index]?.codePointAt(0) ?? 0);
    }
    return width;
  }

  /** 把显示列换算成目标视觉行内的码点下标;列超出行宽时夹到行尾。 */
  private indexAtColumn(row: { start: number; end: number }, column: number): number {
    let used = 0;
    for (let index = row.start; index < row.end; index += 1) {
      const charWidth = codePointWidth(this.chars[index]?.codePointAt(0) ?? 0);
      if (used + charWidth > column) {
        return index;
      }
      used += charWidth;
    }
    return row.end;
  }

  moveLeft(): void {
    if (this.cursorIndex > 0) {
      this.cursorIndex -= 1;
    }
  }

  moveRight(): void {
    if (this.cursorIndex < this.chars.length) {
      this.cursorIndex += 1;
    }
  }

  moveHome(): void {
    this.cursorIndex = this.currentLineStart();
  }

  moveEnd(): void {
    this.cursorIndex = this.currentLineEnd();
  }

  /** 上:有折行宽度时按视觉行上移(最顶视觉行才接历史);否则逻辑行上移、最后历史。 */
  moveUp(): boolean {
    if (this.wrapWidth !== undefined && this.wrapWidth > 0) {
      const rows = this.visualRows();
      const rowIndex = this.currentVisualRow(rows);
      if (rowIndex === 0) {
        return this.historyPrev();
      }
      const column = this.rowColumn(rows[rowIndex]!);
      const previous = rows[rowIndex - 1]!;
      this.cursorIndex = this.indexAtColumn(previous, column);
      return true;
    }
    const lineStart = this.currentLineStart();
    if (lineStart > 0) {
      const column = this.cursorIndex - lineStart;
      const previousStart = this.chars.lastIndexOf('\n', lineStart - 2) + 1;
      const previousEnd = lineStart - 1;
      this.cursorIndex = Math.min(previousStart + column, previousEnd);
      return true;
    }
    return this.historyPrev();
  }

  /** 下:与上对称。 */
  moveDown(): boolean {
    if (this.wrapWidth !== undefined && this.wrapWidth > 0) {
      const rows = this.visualRows();
      const rowIndex = this.currentVisualRow(rows);
      if (rowIndex >= rows.length - 1) {
        return this.historyNext();
      }
      const column = this.rowColumn(rows[rowIndex]!);
      const next = rows[rowIndex + 1]!;
      this.cursorIndex = this.indexAtColumn(next, column);
      return true;
    }
    const lineEnd = this.currentLineEnd();
    if (lineEnd < this.chars.length) {
      const column = this.cursorIndex - this.currentLineStart();
      const nextStart = lineEnd + 1;
      const nextEnd = this.chars.indexOf('\n', nextStart);
      const limit = nextEnd === -1 ? this.chars.length : nextEnd;
      this.cursorIndex = Math.min(nextStart + column, limit);
      return true;
    }
    return this.historyNext();
  }

  historyPrev(): boolean {
    if (this.history.length === 0) {
      return false;
    }
    if (this.historyPos === null) {
      this.draftChars = [...this.chars];
      this.historyPos = this.history.length;
    }
    if (this.historyPos > 0) {
      this.historyPos -= 1;
      this.setChars(this.history[this.historyPos] ?? '', true);
    }
    return true;
  }

  historyNext(): boolean {
    if (this.historyPos === null) {
      return false;
    }
    if (this.historyPos >= this.history.length - 1) {
      this.historyPos = null;
      this.setChars(this.draftChars.join(''), true);
      return true;
    }
    this.historyPos += 1;
    this.setChars(this.history[this.historyPos] ?? '', true);
    return true;
  }

  /** 整体替换输入内容并把光标移到末尾;供菜单接受候选后改写词条用。 */
  replaceWith(text: string): void {
    this.setChars(text);
  }

  /** 用文本替换 [start, end) 这段码点,并把光标停在替换内容之后。 */
  replaceRange(start: number, end: number, text: string): void {
    const replacement = [...text];
    this.chars.splice(start, end - start, ...replacement);
    this.cursorIndex = start + replacement.length;
    this.afterEdit();
  }

  /** 提交:返回文本并清空(非空文本进入历史)。 */
  submit(): string {
    const text = this.text;
    if (text.trim() !== '') {
      this.history.push(text);
      if (this.history.length > 200) {
        this.history.shift();
      }
    }
    this.clear();
    return text;
  }

  clear(): void {
    this.chars = [];
    this.cursorIndex = 0;
    this.historyPos = null;
    this.draftChars = [];
    this.afterEdit();
  }

  /** 光标所在的显示行与列(列以码点计)。 */
  cursorLineColumn(): { line: number; column: number } {
    const start = this.currentLineStart();
    const line = this.text.slice(0, start).split('\n').length - 1;
    return { line, column: this.cursorIndex - start };
  }

  private currentLineStart(): number {
    return this.chars.lastIndexOf('\n', this.cursorIndex - 1) + 1;
  }

  private currentLineEnd(): number {
    const index = this.chars.indexOf('\n', this.cursorIndex);
    return index === -1 ? this.chars.length : index;
  }

  private setChars(text: string, keepHistory = false): void {
    this.chars = [...text];
    this.cursorIndex = this.chars.length;
    if (!keepHistory) {
      this.historyPos = null;
    }
  }

  private afterEdit(): void {
    this.historyPos = null;
  }
}
