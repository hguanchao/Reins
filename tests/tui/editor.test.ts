import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InputEditor } from '../../src/tui/editor.ts';

describe('输入行编辑器', () => {
  it('插入、删除与光标移动', () => {
    const editor = new InputEditor();
    editor.insert('hello');
    assert.equal(editor.text, 'hello');
    editor.moveLeft();
    editor.moveLeft();
    editor.backspace();
    assert.equal(editor.text, 'helo');
    editor.moveHome();
    editor.moveRight();
    editor.insert('X');
    assert.equal(editor.text, 'hXelo');
    editor.moveEnd();
    editor.deleteForward();
    assert.equal(editor.text, 'hXelo');
  });

  it('换行插入与多行移动', () => {
    const editor = new InputEditor();
    editor.insert('ab');
    editor.insertNewline();
    editor.insert('cd');
    assert.equal(editor.text, 'ab\ncd');
    assert.deepEqual(editor.cursorLineColumn(), { line: 1, column: 2 });
    editor.moveUp();
    assert.deepEqual(editor.cursorLineColumn(), { line: 0, column: 2 });
    editor.moveDown();
    assert.deepEqual(editor.cursorLineColumn(), { line: 1, column: 2 });
  });

  it('历史:上一条/下一条与草稿恢复', () => {
    const editor = new InputEditor();
    editor.insert('first');
    editor.submit();
    editor.insert('second');
    editor.submit();
    assert.equal(editor.text, '');
    editor.insert('draft');
    editor.moveUp();
    assert.equal(editor.text, 'second');
    editor.moveUp();
    assert.equal(editor.text, 'first');
    editor.moveDown();
    assert.equal(editor.text, 'second');
    editor.moveDown();
    assert.equal(editor.text, 'draft');
  });

  it('补全:过滤、选择与应用', () => {
    const editor = new InputEditor(['/help', '/model', '/mcp', '/new']);
    editor.insert('/m');
    const initial = editor.completionState;
    if (initial === null) throw new Error('应出现补全菜单');
    assert.deepEqual(initial.items, ['/model', '/mcp']);
    editor.moveDown();
    const second = editor.completionState;
    if (second === null) throw new Error('应出现补全菜单');
    assert.equal(second.index, 1);
    editor.moveDown();
    const wrapped = editor.completionState;
    if (wrapped === null) throw new Error('应出现补全菜单');
    assert.equal(wrapped.index, 0);
    assert.equal(editor.applyCompletion(), true);
    assert.equal(editor.text, '/model ');
    assert.equal(editor.completionState, null);
  });

  it('完全匹配的命令不再提示补全', () => {
    const editor = new InputEditor(['/help']);
    editor.insert('/help');
    assert.equal(editor.completionState, null);
  });

  it('向前删词', () => {
    const editor = new InputEditor();
    editor.insert('foo bar baz');
    editor.deleteWordBackward();
    assert.equal(editor.text, 'foo bar ');
    editor.deleteWordBackward();
    assert.equal(editor.text, 'foo ');
  });

  it('提交后清空并入历史', () => {
    const editor = new InputEditor();
    editor.insert('任务');
    assert.equal(editor.submit(), '任务');
    assert.equal(editor.text, '');
    assert.equal(editor.isEmpty, true);
  });
});
