import {
  renderBlockVerbose,
  type RenderContext,
  type ScrollBlock,
} from './blocks.ts';
import { fitPlain, truncatePlain, visibleWidth } from './layout.ts';

/**
 * 全屏查看器:整屏检视单个区块(通常是完整工具输出)。
 *
 * 设计意图:只管理「看哪一个、看到哪」的状态与整屏排版;
 * 按键语义(滚动/切换/关闭)由应用层分发,便于单测与复用。
 */

export class Viewer {
  private index = -1;
  private scrollTop = 0;
  /** 只缓存当前查看区块的完整渲染:查看器一次只显示一个区块,旧条目没必要留着。 */
  private verboseCache: { block: ScrollBlock; stamp: string; lines: string[] } | undefined;

  get isOpen(): boolean {
    return this.index >= 0;
  }

  get targetIndex(): number {
    return this.index;
  }

  /** 打开并定位到某个区块;已在查看同区块时保持滚动位置。 */
  open(index: number): void {
    if (this.index === index) {
      return;
    }
    this.index = index;
    this.scrollTop = 0;
  }

  close(): void {
    this.index = -1;
    this.scrollTop = 0;
  }

  /** 相对滚动;正数向下。会在 render 时按内容高度收敛。 */
  scroll(delta: number): void {
    this.scrollTop += delta;
  }

  pageUp(height: number): void {
    this.scrollTop -= Math.max(1, height - 3);
  }

  pageDown(height: number): void {
    this.scrollTop += Math.max(1, height - 3);
  }

  home(): void {
    this.scrollTop = 0;
  }

  end(): void {
    this.scrollTop = Number.POSITIVE_INFINITY;
  }

  /** 切换到相邻区块;到达边界时不动。 */
  step(delta: number, count: number): void {
    if (count === 0) {
      this.close();
      return;
    }
    if (this.index < 0) {
      this.open(delta >= 0 ? 0 : count - 1);
      return;
    }
    const next = this.index + delta;
    if (next < 0 || next >= count) {
      return;
    }
    this.open(next);
  }

  /** 生成恰好 height 行的整屏内容。 */
  render(blocks: readonly ScrollBlock[], width: number, height: number, context: RenderContext): string[] {
    if (height < 3) {
      return [truncatePlain('查看器区域过小', Math.max(0, width))];
    }
    if (this.index >= blocks.length) {
      this.index = blocks.length - 1;
    }
    if (this.index < 0) {
      this.close();
    }
    const block = this.index >= 0 ? blocks[this.index] : undefined;
    if (block === undefined) {
      return [fitPlain('没有可查看的内容', width), ...emptyRows(height - 1)];
    }

    const body = this.verboseLines(block, width, context);
    const viewHeight = height - 2;
    const maxTop = Math.max(0, body.length - viewHeight);
    this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxTop);
    const top = Math.floor(this.scrollTop);

    const position =
      body.length <= viewHeight
        ? `共 ${body.length} 行`
        : `第 ${top + 1}–${Math.min(top + viewHeight, body.length)} 行 / 共 ${body.length} 行`;
    const rows: string[] = [renderTitle(block, position, width, context)];
    rows.push(...body.slice(top, top + viewHeight));
    while (rows.length < height - 1) {
      rows.push('');
    }
    rows.push(context.theme.paint.muted(fitPlain('↑↓/PgUp/PgDn 滚动 · n/p 上/下一个区块 · Esc/Q 关闭', width)));
    return rows;
  }

  /** 当前区块的完整行(按宽度与主题缓存)。 */
  private verboseLines(block: ScrollBlock, width: number, context: RenderContext): string[] {
    const stamp = `${width}|${context.theme.name}|${context.theme.useColor}|${verboseStamp(block)}`;
    const hit = this.verboseCache;
    if (hit !== undefined && hit.block === block && hit.stamp === stamp) {
      return hit.lines;
    }
    const lines = renderBlockVerbose(block, width, context);
    this.verboseCache = { block, stamp, lines };
    return lines;
  }
}

function verboseStamp(block: ScrollBlock): string {
  switch (block.kind) {
    case 'user':
      return `u|${block.text.length}|${block.text.slice(-80)}`;
    case 'assistant':
      return `a|${block.streaming}|${block.text.length}|${block.text.slice(-80)}`;
    case 'tool':
      return `t|${block.state}|${block.elapsedMs ?? ''}|${block.output?.length ?? 0}|${block.detail ?? ''}`;
    case 'notice':
      return `n|${block.level}|${block.text}`;
    case 'welcome':
      return 'w|';
  }
}

function renderTitle(block: ScrollBlock, position: string, width: number, context: RenderContext): string {
  let subject: string;
  switch (block.kind) {
    case 'tool':
      subject = `工具 ${block.name} · ${block.summary}`;
      break;
    case 'user':
      subject = '用户消息';
      break;
    case 'assistant':
      subject = '助手消息';
      break;
    case 'notice':
      subject = '通知';
      break;
    case 'welcome':
      subject = '欢迎';
      break;
  }
  const text = ` 查看 ${subject}   ${position} `;
  return context.theme.inverse(fitPlain(truncatePlain(text, width), width));
}

function emptyRows(count: number): string[] {
  return Array.from({ length: count }, () => '');
}
