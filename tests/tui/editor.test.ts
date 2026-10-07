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

  it('斜杠补全:过滤、选择与应用', () => {
    const editor = new InputEditor({ commands: ['/help', '/model', '/mcp', '/new'] });
    editor.insert('/m');
    const initial = editor.completionState;
    if (initial === null) throw new Error('应出现补全菜单');
    assert.equal(initial.kind, 'slash');
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
    const editor = new InputEditor({ commands: ['/help'] });
    editor.insert('/help');
    assert.equal(editor.completionState, null);
  });

  it('@ 补全:词首触发、按查询过滤、Tab 选中', () => {
    const editor = new InputEditor({
      files: () => ['src/tui/app.ts', 'src/tui/editor.ts', 'README.md'],
    });
    editor.insert('看一下 @app');
    const completion = editor.completionState;
    if (completion === null) throw new Error('应出现 mention 补全');
    assert.equal(completion.kind, 'mention');
    assert.deepEqual(completion.items, ['src/tui/app.ts']);
    assert.equal(editor.applyCompletion(), true);
    assert.equal(editor.text, '看一下 @src/tui/app.ts ');
    assert.equal(editor.completionState, null);
  });

  it('@ 补全:非词首的 @ 不触发', () => {
    const editor = new InputEditor({ files: () => ['src/a.ts'] });
    editor.insert('mail me@example.com');
    assert.equal(editor.completionState, null);
  });

  it('@ 补全:光标在空白处不触发,移入 token 后恢复', () => {
    const editor = new InputEditor({ files: () => ['src/a.ts'] });
    editor.insert('@src/a.ts ');
    // 先拷贝到局部变量再断言,避免 assert 系列把属性访问窄化为 null
    const before = editor.completionState;
    assert.ok(before === null);
    editor.moveLeft();
    const completion = editor.completionState;
    if (completion === null) throw new Error('光标回到 token 内应出现补全');
    assert.equal(completion.kind, 'mention');
  });

  it('@ 补全:应用时只替换光标所在 token', () => {
    const editor = new InputEditor({ files: () => ['src/long/path.ts'] });
    editor.insert('对比 @pat 和');
    editor.moveLeft();
    editor.moveLeft();
    assert.equal(editor.applyCompletion(), true);
    assert.equal(editor.text, '对比 @src/long/path.ts  和');
  });

  it('文件快照更新后 refreshCompletion 生效', () => {
    let files: string[] = [];
    const editor = new InputEditor({ files: () => files });
    editor.insert('@a');
    const beforeFirst = editor.completionState;
    assert.equal(beforeFirst, null);
    files = ['a.ts'];
    editor.refreshCompletion();
    const completion = editor.completionState;
    if (completion === null) throw new Error('刷新后应出现补全');
    assert.deepEqual(completion.items, ['a.ts']);
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
});
