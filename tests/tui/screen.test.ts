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

  it('光标为 null 时隐藏,给位置时显示并移动', () => {
    const output = new MockStream();
    const input = new MockStream();
    const terminal = new Terminal(output as never, input as never);
    terminal.render(['x'], { row: 2, col: 5 });
    assert.ok(output.output.includes('\u001b[?25h'), '应显示光标');
    assert.ok(output.output.includes('\u001b[3;6H'), '应把光标移到指定位置');
    output.output = '';
    terminal.render(['x'], null);
    assert.ok(output.output.includes('\u001b[?25l'), '应隐藏光标');
    assert.equal(output.output.includes('\u001b[?25h'), false);
  });

  it('整帧无改动且光标未变时什么都不写,避免重置终端闪烁计时', () => {
    const output = new MockStream();
    const input = new MockStream();
    const terminal = new Terminal(output as never, input as never);
    terminal.render(['x'], { row: 1, col: 3 });
    output.output = '';
    terminal.render(['x'], { row: 1, col: 3 });
    assert.equal(output.output, '');
  });

  it('重绘过行就要重定位光标,否则它会留在最后重绘的那一行末尾', () => {
    const output = new MockStream();
    const input = new MockStream();
    const terminal = new Terminal(output as never, input as never);
    terminal.render(['x'], { row: 1, col: 3 });
    output.output = '';
    // 内容变、光标位置没变:写行已经让物理光标跑了,必须把它收回原处
    terminal.render(['y'], { row: 1, col: 3 });
    assert.ok(output.output.includes('\u001b[2;4H'), '重绘后应把光标收回原处');
    assert.equal(output.output.includes('\u001b[?25h'), false, '已显示时不必重复显示');
    output.output = '';
    // 光标位置变了:重新定位,但无需再发显示序列
    terminal.render(['y'], { row: 1, col: 4 });
    assert.ok(output.output.includes('\u001b[2;5H'), '光标移动时应重新定位');
    assert.equal(output.output.includes('\u001b[?25h'), false);
    output.output = '';
    // 已经隐藏时不再重复发隐藏序列
    terminal.render(['y'], null);
    assert.ok(output.output.includes('\u001b[?25l'));
    output.output = '';
    terminal.render(['y'], null);
    assert.equal(output.output.includes('\u001b[?25l'), false);
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
