import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKeyDecoder } from '../../src/tui/keys.ts';

/** 把一次喂入当成完整输入流,收集全部事件后 flush。 */
function decode(input: string): { type: string; text?: string; delta?: number }[] {
  const decoder = createKeyDecoder();
  const events = decoder.feed(input);
  return [...events, ...decoder.flush()] as { type: string }[];
}

describe('输入解码', () => {
  it('普通文本与中文', () => {
    assert.deepEqual(decode('ab'), [{ type: 'text', text: 'ab' }]);
    assert.deepEqual(decode('你好'), [{ type: 'text', text: '你好' }]);
  });

  it('控制键映射', () => {
    assert.deepEqual(decode('\r'), [{ type: 'enter' }]);
    assert.deepEqual(decode('\n'), [{ type: 'ctrl-j' }]);
    assert.deepEqual(decode('\t'), [{ type: 'tab' }]);
    assert.deepEqual(decode('\u007f'), [{ type: 'backspace' }]);
    assert.deepEqual(decode('\u0003'), [{ type: 'ctrl-c' }]);
    assert.deepEqual(decode('\u0004'), [{ type: 'ctrl-d' }]);
    assert.deepEqual(decode('\u0015'), [{ type: 'ctrl-u' }]);
    assert.deepEqual(decode('\u0017'), [{ type: 'ctrl-w' }]);
    assert.deepEqual(decode('\u0005'), [{ type: 'ctrl-e' }]);
    assert.deepEqual(decode('\u000f'), [{ type: 'ctrl-o' }]);
  });

  it('方向键、翻页与 Home/End', () => {
    assert.deepEqual(decode('\u001b[A'), [{ type: 'up' }]);
    assert.deepEqual(decode('\u001b[B'), [{ type: 'down' }]);
    assert.deepEqual(decode('\u001b[C'), [{ type: 'right' }]);
    assert.deepEqual(decode('\u001b[D'), [{ type: 'left' }]);
    assert.deepEqual(decode('\u001b[5~'), [{ type: 'pageup' }]);
    assert.deepEqual(decode('\u001b[6~'), [{ type: 'pagedown' }]);
    assert.deepEqual(decode('\u001b[H'), [{ type: 'home' }]);
    assert.deepEqual(decode('\u001b[F'), [{ type: 'end' }]);
    assert.deepEqual(decode('\u001b[3~'), [{ type: 'delete' }]);
    assert.deepEqual(decode('\u001b[Z'), [{ type: 'shift-tab' }]);
  });

  it('孤立 Esc 交给 flush 兜底', () => {
    const decoder = createKeyDecoder();
    assert.deepEqual(decoder.feed('\u001b'), []);
    assert.deepEqual(decoder.flush(), [{ type: 'escape' }]);
    assert.equal(decoder.hasPending(), false);
  });

  it('残缺序列等待更多数据', () => {
    const decoder = createKeyDecoder();
    assert.deepEqual(decoder.feed('\u001b['), []);
    assert.equal(decoder.hasPending(), true);
    assert.deepEqual(decoder.feed('A'), [{ type: 'up' }]);
    assert.equal(decoder.hasPending(), false);
  });

  it('带修饰键的方向键按终结符归类,不落成文本', () => {
    assert.deepEqual(decode('\u001b[1;5A'), [{ type: 'up' }]);
    assert.deepEqual(decode('\u001b[1;2B'), [{ type: 'down' }]);
    assert.deepEqual(decode('\u001b[1;3C'), [{ type: 'right' }]);
    assert.deepEqual(decode('\u001b[1;5D'), [{ type: 'left' }]);
    assert.deepEqual(decode('\u001b[3;5~'), [{ type: 'delete' }]);
    assert.deepEqual(decode('\u001b[5;2~'), [{ type: 'pageup' }]);
    // 关键:参数绝不能落成普通文本插进输入框
    assert.equal(decode('\u001b[1;5A').some((event) => event.type === 'text'), false);
  });

  it('残缺序列跨块且中途 flush 时不丢,补齐后仍能识别', () => {
    const decoder = createKeyDecoder();
    assert.deepEqual(decoder.feed('\u001b['), []);
    // 静默超时:保留缓冲,否则后半截会变成文本(方向键插出 "A")
    assert.deepEqual(decoder.flush(), []);
    assert.equal(decoder.hasPending(), true);
    assert.deepEqual(decoder.feed('A'), [{ type: 'up' }]);
    assert.equal(decoder.hasPending(), false);
  });

  it('SGR 鼠标滚轮:64 上 65 下,松开忽略', () => {
    assert.deepEqual(decode('\u001b[<64;10;5M'), [{ type: 'wheel', delta: -3 }]);
    assert.deepEqual(decode('\u001b[<65;10;5M'), [{ type: 'wheel', delta: 3 }]);
    assert.deepEqual(decode('\u001b[<64;10;5m'), [{ type: 'unknown' }]);
    assert.deepEqual(decode('\u001b[<0;10;5M'), [{ type: 'unknown' }]);
  });

  it('X10 鼠标滚轮', () => {
    // 按钮 64 → 字节 64+32;x=10,y=5
    assert.deepEqual(decode('\u001b[M`_\u0005'), [{ type: 'wheel', delta: -3 }]);
  });

  it('括号粘贴:整段交付,换行不变成回车', () => {
    assert.deepEqual(decode('\u001b[200~第一行\n第二行\u001b[201~'), [
      { type: 'paste', text: '第一行\n第二行' },
    ]);
  });

  it('括号粘贴:跨块到达并处理 CR/LF', () => {
    const decoder = createKeyDecoder();
    const events = [
      ...decoder.feed('\u001b[200~hello\r\nwo'),
      ...decoder.feed('rld\u001b[201~'),
      ...decoder.flush(),
    ];
    assert.deepEqual(events, [{ type: 'paste', text: 'hello\nworld' }]);
  });

  it('粘贴结束标记部分跨块时不错切', () => {
    const decoder = createKeyDecoder();
    const events = [
      ...decoder.feed('\u001b[200~abc\u001b'),
      ...decoder.feed('[201~'),
      ...decoder.flush(),
    ];
    assert.deepEqual(events, [{ type: 'paste', text: 'abc' }]);
  });

  it('粘贴内容剥离控制字符但保留 emoji', () => {
    assert.deepEqual(decode('\u001b[200~a\u0002b\u007fc😀\u001b[201~'), [
      { type: 'paste', text: 'abc😀' },
    ]);
  });

  it('文本与转义序列连续到达时各自正确解析', () => {
    const events = decode('abc\u001b[Bdef');
    assert.deepEqual(events, [
      { type: 'text', text: 'abc' },
      { type: 'down' },
      { type: 'text', text: 'def' },
    ]);
  });

  it('焦点事件被识别,私有模式回执仍被忽略', () => {
    assert.deepEqual(decode('\u001b[I\u001b[O\u001b[?2004h'), [
      { type: 'focus-in' },
      { type: 'focus-out' },
    ]);
  });
});
