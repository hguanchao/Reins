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

  it('粘贴插入:保留换行并返回行数', () => {
    const editor = new InputEditor();
    editor.insert('前');
    assert.equal(editor.insertRaw('第一行\n第二行'), 2);
    assert.equal(editor.text, '前第一行\n第二行');
    editor.moveHome();
    assert.equal(editor.insertRaw('X'), 1);
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

  it('折行宽度已知时 ↑↓ 在视觉行间移动,边界才接历史', () => {
    const editor = new InputEditor();
    editor.insert('旧记录');
    editor.submit();
    editor.setWrapWidth(4);
    editor.insert('abcdefgh'); // 视觉行:abcd | efgh
    editor.moveEnd();           // 光标在 efgh 行尾
    assert.equal(editor.moveDown(), false, '最后一个视觉行再按 ↓,历史为空应不动');
    assert.equal(editor.text, 'abcdefgh', '草稿不应被替换');
    assert.equal(editor.moveUp(), true);
    assert.equal(editor.cursor, 4, '上移:边界列归下一行,落在 efgh 行首');
    editor.moveUp();
    assert.equal(editor.cursor, 0, '再 ↑ 进入 abcd 行首');
    editor.moveUp();            // 已在最顶视觉行 → 历史
    assert.equal(editor.text, '旧记录');
    assert.equal(editor.moveDown(), true, '历史下翻回到草稿');
    assert.equal(editor.text, 'abcdefgh');
    assert.equal(editor.moveDown(), false);
  });

  it('折行与多行叠加:视觉行跨逻辑行连续移动', () => {
    const editor = new InputEditor();
    editor.setWrapWidth(4);
    editor.insert('abcd');
    editor.insertNewline();
    editor.insert('efghij');    // 视觉行:abcd | efgh | ij
    editor.moveHome();          // 光标到逻辑行 1 行首
    assert.equal(editor.cursor, 5);
    editor.moveUp();
    assert.equal(editor.cursor, 0, '上移进逻辑行 0');
    editor.moveDown();
    assert.equal(editor.cursor, 5, '下移到 efgh 行首');
    editor.moveDown();
    assert.equal(editor.cursor, 9, '下移到 ij 行首');
    assert.equal(editor.moveDown(), false, '最后视觉行,历史为空');
  });

  it('未设置折行宽度时保持逻辑行移动的旧行为', () => {
    const editor = new InputEditor();
    editor.insert('ab');
    editor.insertNewline();
    editor.insert('cd');
    editor.moveUp();
    assert.equal(editor.cursor, 2, '按逻辑行移动到上一行');
    assert.equal(editor.moveUp(), false, '已在首行,历史为空');
  });
});
