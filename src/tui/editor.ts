/**
 * 输入行编辑器:光标、历史、斜杠命令补全。
 *
 * 设计意图:纯状态机、不碰终端;文本按码点维护,避免拆断代理对;
 * 支持多行(^J 换行),光标与历史在被上层按键分发调用时保持可预测。
 */

export interface EditorCompletion {
  items: string[];
  index: number;
}

export class InputEditor {
  private chars: string[] = [];
  private cursorIndex = 0;
  private history: string[] = [];
  private historyPos: number | null = null;
  private draftChars: string[] = [];
  private completion: EditorCompletion | null = null;
  private readonly commands: readonly string[];

  constructor(commands: readonly string[] = []) {
    this.commands = commands;
  }

  get text(): string {
    return this.chars.join('');
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  get completionState(): EditorCompletion | null {
    return this.completion;
  }

  /** 插入可打印文本(换行被忽略,由 insertNewline 处理)。 */
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

  /** 上:优先补全菜单,其次多行上移,最后历史。 */
  moveUp(): boolean {
    if (this.completion !== null) {
      this.completionStep(-1);
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
    if (this.completion !== null) {
      this.completionStep(1);
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

  /** 应用当前补全项(回车或 Tab);无补全时返回 false。 */
  applyCompletion(): boolean {
    if (this.completion === null) {
      return false;
    }
    const item = this.completion.items[this.completion.index];
    if (item === undefined) {
      return false;
    }
    this.setChars(`${item} `);
    return true;
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

  private completionStep(delta: number): void {
    if (this.completion === null) {
      return;
    }
    const count = this.completion.items.length;
    this.completion.index = (this.completion.index + delta + count) % count;
  }

  private setChars(text: string, keepHistory = false): void {
    this.chars = [...text];
    this.cursorIndex = this.chars.length;
    if (!keepHistory) {
      this.historyPos = null;
    }
    this.recomputeCompletion();
  }

  private afterEdit(): void {
    this.historyPos = null;
    this.recomputeCompletion();
  }

  private recomputeCompletion(): void {
    const text = this.text;
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) {
      this.completion = null;
      return;
    }
    const items = this.commands.filter((command) => command.startsWith(text) && command !== text);
    this.completion = items.length > 0 ? { items, index: 0 } : null;
  }
}
