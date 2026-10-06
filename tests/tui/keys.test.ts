import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapKeypress } from '../../src/tui/keys.ts';

describe('按键映射', () => {
  it('控制键', () => {
    assert.equal(mapKeypress('\u0003', { name: 'c', ctrl: true }).type, 'ctrl-c');
    assert.equal(mapKeypress('\u0004', { name: 'd', ctrl: true }).type, 'ctrl-d');
    assert.equal(mapKeypress('\n', { name: 'j', ctrl: true }).type, 'ctrl-j');
    assert.equal(mapKeypress('\u0015', { name: 'u', ctrl: true }).type, 'ctrl-u');
    assert.equal(mapKeypress('\u0017', { name: 'w', ctrl: true }).type, 'ctrl-w');
  });

  it('回车与换行区分', () => {
    assert.equal(mapKeypress('\r', { name: 'return' }).type, 'enter');
    assert.equal(mapKeypress('\n', { name: 'enter' }).type, 'ctrl-j');
  });

  it('方向键与翻页', () => {
    assert.equal(mapKeypress('\u001b[A', { name: 'up' }).type, 'up');
    assert.equal(mapKeypress('\u001b[B', { name: 'down' }).type, 'down');
    assert.equal(mapKeypress('\u001b[C', { name: 'right' }).type, 'right');
    assert.equal(mapKeypress('\u001b[D', { name: 'left' }).type, 'left');
    assert.equal(mapKeypress('\u001b[5~', { name: 'pageup' }).type, 'pageup');
    assert.equal(mapKeypress('\u001b[6~', { name: 'pagedown' }).type, 'pagedown');
    assert.equal(mapKeypress('\u001b', { name: 'escape' }).type, 'escape');
    assert.equal(mapKeypress('\t', { name: 'tab' }).type, 'tab');
    assert.equal(mapKeypress('\u007f', { name: 'backspace' }).type, 'backspace');
  });

  it('普通字符与中文按文本处理', () => {
    assert.deepEqual(mapKeypress('a', { name: 'a' }), { type: 'text', text: 'a' });
    assert.deepEqual(mapKeypress('中', { name: undefined }), { type: 'text', text: '中' });
    assert.deepEqual(mapKeypress(' ', { name: 'space' }), { type: 'text', text: ' ' });
  });

  it('未知转义序列归为 unknown', () => {
    assert.equal(mapKeypress('\u001b[<35;1;1M', { name: undefined }).type, 'unknown');
    assert.equal(mapKeypress(undefined, { name: 'f5' }).type, 'unknown');
  });
});
