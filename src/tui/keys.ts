/**
 * 按键解析:把终端的原始按键事件归一为 TuiKey。
 *
 * 设计意图:与 Node 的 keypress 事件对接;仅做映射,不做业务判断,便于单测。
 */

export interface RawKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

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
  | { type: 'escape' }
  | { type: 'ctrl-c' }
  | { type: 'ctrl-d' }
  | { type: 'ctrl-u' }
  | { type: 'ctrl-w' }
  | { type: 'unknown' };

export function mapKeypress(str: string | undefined, key: RawKey | undefined): TuiKey {
  if (key === undefined) {
    return str !== undefined && str.length > 0 ? { type: 'text', text: str } : { type: 'unknown' };
  }
  if (key.ctrl === true) {
    switch ((key.name ?? '').toLowerCase()) {
      case 'c':
        return { type: 'ctrl-c' };
      case 'd':
        return { type: 'ctrl-d' };
      case 'j':
        return { type: 'ctrl-j' };
      case 'u':
        return { type: 'ctrl-u' };
      case 'w':
        return { type: 'ctrl-w' };
      default:
        return { type: 'unknown' };
    }
  }
  if (key.meta === true) {
    return { type: 'unknown' };
  }
  switch (key.name) {
    case 'return':
      return { type: 'enter' };
    case 'enter':
      // 单独的换行符(^J)用于插入换行
      return { type: 'ctrl-j' };
    case 'backspace':
      return { type: 'backspace' };
    case 'delete':
      return { type: 'delete' };
    case 'left':
      return { type: 'left' };
    case 'right':
      return { type: 'right' };
    case 'up':
      return { type: 'up' };
    case 'down':
      return { type: 'down' };
    case 'home':
      return { type: 'home' };
    case 'end':
      return { type: 'end' };
    case 'pageup':
      return { type: 'pageup' };
    case 'pagedown':
      return { type: 'pagedown' };
    case 'tab':
      return { type: 'tab' };
    case 'escape':
      return { type: 'escape' };
    default:
      break;
  }
  if (str !== undefined && str.length > 0 && !str.startsWith('\u001b')) {
    return { type: 'text', text: str };
  }
  return { type: 'unknown' };
}
