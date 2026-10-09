/**
 * 终端层:备用屏、raw 模式、帧差分输出。
 *
 * 设计意图:只保留「把帧写进终端」这一件事;差分计算为纯函数,
 * 逐行只重绘变化行,避免整屏闪烁。
 */

export interface FrameDiffRow {
  row: number;
  text: string;
}

export interface CursorPosition {
  /** 0 基行号。 */
  row: number;
  /** 0 基显示列号。 */
  col: number;
}

/** 纯函数:对比前后两帧,输出需要重绘的行。 */
export function computeFrameDiff(previous: readonly string[], next: readonly string[]): FrameDiffRow[] {
  const diffs: FrameDiffRow[] = [];
  // 取两者较大长度:新帧变短时(如切到「窗口太小」页)也要把多出的行擦成空行,
  // 否则旧内容会残留在屏幕上
  const rows = Math.max(previous.length, next.length);
  for (let row = 0; row < rows; row += 1) {
    const text = next[row] ?? '';
    if (previous[row] !== text) {
      diffs.push({ row, text });
    }
  }
  return diffs;
}

export class Terminal {
  readonly out: NodeJS.WriteStream;
  readonly input: NodeJS.ReadStream;
  private previousFrame: string[] = [];
  /** 上一帧的光标状态:undefined = 未知,null = 已隐藏。 */
  private previousCursor: CursorPosition | null | undefined = undefined;
  private entered = false;

  constructor(out: NodeJS.WriteStream, input: NodeJS.ReadStream) {
    this.out = out;
    this.input = input;
  }

  get columns(): number {
    return this.out.columns ?? 80;
  }

  get rows(): number {
    return this.out.rows ?? 24;
  }

  /** 进入备用屏并切换到 raw 模式。 */
  enter(): void {
    if (this.entered) {
      return;
    }
    this.entered = true;
    if (this.input.isTTY === true) {
      this.input.setRawMode(true);
    }
    this.input.resume();
    // 备用屏 + 隐藏光标 + 鼠标/焦点上报 + 括号粘贴
    this.out.write('\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1006h\u001b[?1004h\u001b[?2004h');
    this.previousFrame = [];
    this.previousCursor = null;
  }

  /** 离开备用屏并恢复终端状态。 */
  leave(): void {
    if (!this.entered) {
      return;
    }
    this.entered = false;
    // 退出顺序与进入相反,确保异常路径下终端不留残余模式
    this.out.write('\u001b[?2004l\u001b[?1004l\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[?1049l');
    this.previousCursor = undefined;
    if (this.input.isTTY === true) {
      this.input.setRawMode(false);
    }
    this.input.pause();
  }

  /** 使下一帧全量重绘(窗口尺寸变化时使用)。 */
  invalidate(): void {
    this.previousFrame = [];
    this.previousCursor = undefined;
  }

  render(lines: readonly string[], cursor: CursorPosition | null): void {
    const diffs = computeFrameDiff(this.previousFrame, lines);
    const chunks: string[] = [];
    for (const diff of diffs) {
      chunks.push(`\u001b[${diff.row + 1};1H\u001b[2K`, diff.text);
    }
    // 光标只在状态真正变化时才写:每帧重定位会把终端的闪烁计时重置,
    // 光标看起来会一直亮着(不闪烁)
    if (cursor === null) {
      if (this.previousCursor !== null) {
        chunks.push('\u001b[?25l');
      }
    } else {
      const visible = this.previousCursor !== null && this.previousCursor !== undefined;
      const moved = !visible || this.previousCursor?.row !== cursor.row || this.previousCursor?.col !== cursor.col;
      if (moved) {
        chunks.push(`\u001b[${cursor.row + 1};${cursor.col + 1}H`);
      }
      if (!visible) {
        chunks.push('\u001b[?25h');
      }
    }
    this.previousCursor = cursor;
    this.previousFrame = [...lines];
    this.out.write(chunks.join(''));
  }
}
