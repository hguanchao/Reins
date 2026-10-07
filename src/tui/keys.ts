/**
 * 输入解码:把终端的原始字节流切成语义按键。
 *
 * 设计意图:Node 内建的 keypress 解析不认识 SGR 鼠标序列,会把它们
 * 拆成零散字符,因此这里自建一个增量状态机——喂入字节块、吐出按键事件;
 * 同时承接括号粘贴(整段插入、换行不触发提交)与鼠标滚轮。
 * 不完整的转义序列留在缓冲区,flush() 在超时后兜底吐出(如单独的 Esc)。
 */

export type TuiKey =
  | { type: 'text'; text: string }
  | { type: 'enter' }
  | { type: 'ctrl-j' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'pageup' }
  | { type: 'pagedown' }
  | { type: 'tab' }
  | { type: 'shift-tab' }
  | { type: 'escape' }
  | { type: 'ctrl-c' }
  | { type: 'ctrl-d' }
  | { type: 'ctrl-u' }
  | { type: 'ctrl-w' }
  | { type: 'ctrl-e' }
  | { type: 'ctrl-o' }
  /** 括号粘贴的整段文本;换行已归一为 \n。 */
  | { type: 'paste'; text: string }
  /** 鼠标滚轮;正数向下、负数向上,单位为行。 */
  | { type: 'wheel'; delta: number }
  /** 鼠标事件;行列均为 0 基,供界面做命中测试。 */
  | { type: 'mouse'; kind: 'press' | 'release' | 'move'; row: number; column: number }
  | { type: 'unknown' };

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';
/** 单次粘贴的字符上限:超过即截断,避免一次粘贴拖垮内存与渲染。 */
export const MAX_PASTE_CHARS = 100_000;
/** 每格滚轮滚动的行数。 */
const WHEEL_STEP = 3;

interface ControlDef {
  sequence: string;
  key: TuiKey;
}

/** 固定转义序列 → 按键;按前缀长度优先匹配。 */
const SEQUENCES: readonly ControlDef[] = [
  { sequence: '\u001b[A', key: { type: 'up' } },
  { sequence: '\u001b[B', key: { type: 'down' } },
  { sequence: '\u001b[C', key: { type: 'right' } },
  { sequence: '\u001b[D', key: { type: 'left' } },
  { sequence: '\u001bOA', key: { type: 'up' } },
  { sequence: '\u001bOB', key: { type: 'down' } },
  { sequence: '\u001bOC', key: { type: 'right' } },
  { sequence: '\u001bOD', key: { type: 'left' } },
  { sequence: '\u001b[H', key: { type: 'home' } },
  { sequence: '\u001b[F', key: { type: 'end' } },
  { sequence: '\u001bOH', key: { type: 'home' } },
  { sequence: '\u001bOF', key: { type: 'end' } },
  { sequence: '\u001b[1~', key: { type: 'home' } },
  { sequence: '\u001b[4~', key: { type: 'end' } },
  { sequence: '\u001b[7~', key: { type: 'home' } },
  { sequence: '\u001b[8~', key: { type: 'end' } },
  { sequence: '\u001b[3~', key: { type: 'delete' } },
  { sequence: '\u001b[5~', key: { type: 'pageup' } },
  { sequence: '\u001b[6~', key: { type: 'pagedown' } },
  { sequence: '\u001b[Z', key: { type: 'shift-tab' } },
];

/**
 * 带参数 CSI 的终结符 → 按键。
 *
 * 终端把 Ctrl/Alt+方向键编码成 `\x1b[1;5A` 这类带参数的序列;不归类就会被当成
 * 普通文本插进输入框(方向键变成 "1;5A")。这里忽略修饰参数、按终结符归类。
 */
const CSI_FINALS: Readonly<Record<string, TuiKey>> = {
  A: { type: 'up' },
  B: { type: 'down' },
  C: { type: 'right' },
  D: { type: 'left' },
  F: { type: 'end' },
  H: { type: 'home' },
  Z: { type: 'shift-tab' },
};

/** 带参数的 `~` 形式(如 `\x1b[3;5~`)的编号 → 按键。 */
const TILDE_FINALS: Readonly<Record<number, TuiKey>> = {
  1: { type: 'home' },
  3: { type: 'delete' },
  4: { type: 'end' },
  5: { type: 'pageup' },
  6: { type: 'pagedown' },
  7: { type: 'home' },
  8: { type: 'end' },
};

const CONTROLS: Readonly<Record<string, TuiKey>> = {
  '\r': { type: 'enter' },
  '\n': { type: 'ctrl-j' },
  '\t': { type: 'tab' },
  '\u007f': { type: 'backspace' },
  '\b': { type: 'backspace' },
  '\u0003': { type: 'ctrl-c' },
  '\u0004': { type: 'ctrl-d' },
  '\u0015': { type: 'ctrl-u' },
  '\u0017': { type: 'ctrl-w' },
  '\u0005': { type: 'ctrl-e' },
  '\u000f': { type: 'ctrl-o' },
};

export interface KeyDecoder {
  /** 喂入一块原始输入(Buffer 会按 UTF-8 流式解码),返回其中完整的按键事件。 */
  feed(chunk: Buffer | string): TuiKey[];
  /** 输入流静止后调用:把缓冲区里挂起的孤立 Esc 或残缺序列吐出。 */
  flush(): TuiKey[];
  /** 缓冲区里是否还有未决字节(需要安排 flush 定时器)。 */
  hasPending(): boolean;
}

export function createKeyDecoder(): KeyDecoder {
  const textDecoder = new TextDecoder('utf-8');
  let buf = '';
  let pasting = false;

  const consume = (length: number): void => {
    buf = buf.slice(length);
  };

  /** 尝试从缓冲头部解析一个事件;返回 null 表示需要更多数据。 */
  const parseOne = (): TuiKey | null | 'drain-paste' => {
    if (buf === '') {
      return null;
    }
    if (pasting) {
      const end = buf.indexOf(PASTE_END);
      if (end !== -1) {
        const deliverable = buf.slice(0, end);
        consume(end + PASTE_END.length);
        pasting = false;
        if (deliverable !== '') {
          return pasteEvent(deliverable);
        }
        return 'drain-paste';
      }
      // 没等到结束标记:超过上限时强制收尾,防止缓冲无限增长
      if (buf.length > MAX_PASTE_CHARS) {
        const deliverable = buf;
        buf = '';
        pasting = false;
        return pasteEvent(deliverable);
      }
      return null;
    }

    if (!buf.startsWith('\u001b')) {
      const control = CONTROLS[buf[0] ?? ''];
      if (control !== undefined) {
        consume(1);
        return control;
      }
      if ((buf.codePointAt(0) ?? 0x7f) < 32) {
        consume(1);
        return { type: 'unknown' };
      }
      // 普通文本:一直吃到下一个控制符或转义
      let length = 0;
      while (length < buf.length && !isControlStart(buf[length] ?? '')) {
        length += 1;
      }
      const text = buf.slice(0, length);
      consume(length);
      return { type: 'text', text };
    }

    if (buf.startsWith(PASTE_START)) {
      consume(PASTE_START.length);
      pasting = true;
      return 'drain-paste';
    }
    if (buf.startsWith(PASTE_END)) {
      // 游离的结束标记:直接丢弃
      consume(PASTE_END.length);
      return 'drain-paste';
    }

    const fixed = SEQUENCES.find((def) => buf.startsWith(def.sequence));
    if (fixed !== undefined) {
      consume(fixed.sequence.length);
      return fixed.key;
    }

    // SGR 鼠标:\x1b[<b;x;yM(m 为松开,滚轮只关心按下)
    const sgr = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
    if (sgr !== null) {
      consume(sgr[0].length);
      const button = Number.parseInt(sgr[1] ?? '0', 10);
      const wheel = wheelFromButton(button);
      if (wheel !== 0) {
        // 滚轮的松开序列没有意义,当无法识别丢掉
        return sgr[4] === 'M' ? { type: 'wheel', delta: wheel * WHEEL_STEP } : { type: 'unknown' };
      }
      // 序列里的坐标是 1 基的 列;行,转成 0 基的 行/列
      return {
        type: 'mouse',
        kind: sgr[4] === 'm' ? 'release' : mouseKind(button),
        row: Number.parseInt(sgr[3] ?? '1', 10) - 1,
        column: Number.parseInt(sgr[2] ?? '1', 10) - 1,
      };
    }
    // X10 鼠标:\x1b[M 后跟 3 个字节
    if (buf.startsWith('\u001b[M')) {
      if (buf.length < 6) {
        return null;
      }
      const button = (buf.charCodeAt(3) ?? 0) - 32;
      consume(6);
      const wheel = wheelFromButton(button);
      if (wheel !== 0) {
        return { type: 'wheel', delta: wheel * WHEEL_STEP };
      }
      return {
        type: 'mouse',
        kind: mouseKind(button),
        row: ((buf.charCodeAt(5) ?? 32) - 32) - 1,
        column: ((buf.charCodeAt(4) ?? 32) - 32) - 1,
      };
    }

    // 带参数的 CSI(如 Ctrl+方向键 \x1b[1;5A):忽略参数、按终结符归类
    const csi = /^\u001b\[(\d+(?:;\d+)*)?([A-DFHZ])/.exec(buf);
    if (csi !== null) {
      consume(csi[0].length);
      return CSI_FINALS[csi[2] ?? ''] ?? { type: 'unknown' };
    }
    const tilde = /^\u001b\[(\d+)(?:;\d+)*~/.exec(buf);
    if (tilde !== null) {
      consume(tilde[0].length);
      return TILDE_FINALS[Number.parseInt(tilde[1] ?? '', 10)] ?? { type: 'unknown' };
    }

    // 终端回执类序列(焦点、私有模式应答):吞到终结符,忽略
    if (buf.startsWith('\u001b[I') || buf.startsWith('\u001b[O')) {
      consume(3);
      return 'drain-paste';
    }
    const report = /^\u001b\[\?[0-9;]*[A-Za-z]/.exec(buf);
    if (report !== null) {
      consume(report[0].length);
      return 'drain-paste';
    }
    const osc = buf.startsWith('\u001b]');
    if (osc) {
      const bel = buf.indexOf('\u0007');
      const st = buf.indexOf('\u001b\\');
      if (bel === -1 && st === -1) {
        return null;
      }
      const end = bel === -1 ? (st as number) + 2 : bel + 1;
      consume(end);
      return 'drain-paste';
    }

    // Alt+键 与未知转义:吞掉 ESC 与后续一个字符;
    // 但若缓冲仍可能补全成一个已知序列,则等待更多数据
    if (couldBeEscapePrefix(buf)) {
      return null;
    }
    if (buf.length >= 2) {
      consume(2);
      return { type: 'unknown' };
    }
    return null;
  };

  return {
    feed(chunk) {
      buf += typeof chunk === 'string' ? chunk : textDecoder.decode(chunk, { stream: true });
      const events: TuiKey[] = [];
      for (;;) {
        const event = parseOne();
        if (event === 'drain-paste') {
          continue;
        }
        if (event === null) {
          break;
        }
        events.push(event);
      }
      return events;
    },
    flush() {
      // 粘贴中途静默不代表粘贴结束:保留缓冲等待后续数据
      if (buf === '' || pasting) {
        return [];
      }
      // 孤立的 Esc 才是用户的按键;其余残缺序列可能只是被终端拆成了两块
      // (远程终端、tmux、慢 SSH 常见),丢弃会把后半截当普通文本插进输入框
      if (buf === '\u001b') {
        buf = '';
        return [{ type: 'escape' }];
      }
      if (couldBeEscapePrefix(buf)) {
        return [];
      }
      buf = '';
      return [{ type: 'unknown' }];
    },
    hasPending() {
      return buf !== '';
    },
  };
}

/** 粘贴事件:统一换行符并剥离 C0/C1 控制字符;超限时截断。 */
function pasteEvent(text: string): TuiKey {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return { type: 'paste', text: normalized.slice(0, MAX_PASTE_CHARS) };
}

/**
 * 缓冲是否可能是某个转义序列的前缀(等待更多数据)。
 * 覆盖 ESC、CSI 数字/分号、SGR 鼠标、SS3 与 OSC 引导。
 */
function couldBeEscapePrefix(buf: string): boolean {
  if (buf === '\u001b') {
    return true;
  }
  if (!buf.startsWith('\u001b')) {
    return false;
  }
  const rest = buf.slice(1);
  if (rest === 'O' || rest === ']') {
    return true;
  }
  if (!rest.startsWith('[')) {
    return false;
  }
  const body = rest.slice(1);
  if (body.startsWith('<')) {
    return /^[0-9;]*$/.test(body.slice(1));
  }
  return /^[0-9;]*$/.test(body);
}

function isControlStart(char: string): boolean {
  return char === '\u001b' || char < ' ' || char === '\u007f';
}

/**
 * 按钮码 → 事件类型:第 3 位(8)是松开,第 5 位(32)是移动
 * (拖动或开了任意移动上报),其余按下去。
 */
export function mouseKind(button: number): 'press' | 'release' | 'move' {
  if ((button & 8) !== 0) {
    return 'release';
  }
  if ((button & 32) !== 0) {
    return 'move';
  }
  return 'press';
}

/** SGR/X10 按钮码 → 滚动方向:64 上、65 下。 */
function wheelFromButton(button: number): -1 | 0 | 1 {
  if (button === 64) {
    return -1;
  }
  if (button === 65) {
    return 1;
  }
  return 0;
}
