import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { notify } from '../../src/ui/notify.ts';

describe('系统通知', () => {
  it('off 不产生任何输出', () => {
    const pieces: string[] = [];
    notify('off', '消息', (text) => void pieces.push(text));
    assert.equal(pieces.length, 0);
  });

  it('bell 只响铃', () => {
    const pieces: string[] = [];
    notify('bell', '消息', (text) => void pieces.push(text));
    const all = pieces.join('');
    assert.ok(all.includes('\u0007'));
    assert.equal(all.includes(']9;'), false);
  });

  it('desktop 使用终端通知序列', () => {
    const pieces: string[] = [];
    notify('desktop', '构建完成', (text) => void pieces.push(text));
    const all = pieces.join('');
    assert.ok(all.includes('\u001b]9;构建完成'));
  });

  it('auto 同时响铃与桌面通知', () => {
    const pieces: string[] = [];
    notify('auto', '消息', (text) => void pieces.push(text));
    const all = pieces.join('');
    assert.ok(all.includes('\u0007'));
    assert.ok(all.includes(']9;'));
  });

  it('控制字符被清理', () => {
    const pieces: string[] = [];
    notify('desktop', '危险\u0000内容', (text) => void pieces.push(text));
    assert.ok(pieces.join('').includes('危险 内容'));
  });
});
