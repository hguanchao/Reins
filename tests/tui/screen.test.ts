import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeFrameDiff, Terminal } from '../../src/tui/screen.ts';

class MockStream {
  columns = 80;
  rows = 24;
  isTTY = false;
  output = '';

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

describe('帧差分', () => {
  it('相同帧无差异', () => {
    assert.deepEqual(computeFrameDiff(['a', 'b'], ['a', 'b']), []);
  });

  it('只输出变化行', () => {
    const diffs = computeFrameDiff(['a', 'b', 'c'], ['a', 'X', 'c']);
    assert.deepEqual(diffs, [{ row: 1, text: 'X' }]);
  });

  it('新增行也计入差异', () => {
    const diffs = computeFrameDiff(['a'], ['a', 'b', 'c']);
    assert.deepEqual(diffs, [
      { row: 1, text: 'b' },
      { row: 2, text: 'c' },
    ]);
  });

  it('空帧视为全量变化', () => {
    const diffs = computeFrameDiff([], ['x', 'y']);
    assert.equal(diffs.length, 2);
  });

  it('新帧变短时多出的行被擦成空行', () => {
    const diffs = computeFrameDiff(['a', 'b', 'c'], ['a']);
    assert.deepEqual(diffs, [
      { row: 1, text: '' },
      { row: 2, text: '' },
    ]);
  });

  it('进入和离开时切换焦点上报', () => {
    const output = new MockStream();
    const input = new MockStream();
    const terminal = new Terminal(output as never, input as never);
    terminal.enter();
    assert.ok(output.output.includes('\u001b[?1004h'));
    terminal.leave();
    assert.ok(output.output.includes('\u001b[?1000l'));
    assert.ok(output.output.includes('\u001b[?1006l'));
    assert.ok(output.output.includes('\u001b[?1004l'));
    assert.ok(output.output.includes('\u001b[?2004l'));
    assert.ok(output.output.includes('\u001b[?1049l'));
    const before = output.output;
    terminal.leave();
    assert.equal(output.output, before);
  });
});
