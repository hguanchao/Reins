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

  it('@ 补全:目录项可下钻,插入后不带空格且菜单保持打开', () => {
    const editor = new InputEditor({ files: () => ['src/tui/app.ts', 'src/tui/'] });
    editor.insert('@src/tu');
    const first = editor.completionState;
    if (first === null) throw new Error('应出现补全');
    // 目录路径比其下文件短,同分时排在前
    assert.equal(first.items[0], 'src/tui/');
    assert.equal(editor.applyCompletion(), true);
    // 目录不补尾随空格:引用未结束
    assert.equal(editor.text, '@src/tui/');
    // 菜单继续列出该目录下的内容
    const next = editor.completionState;
    if (next === null) throw new Error('插入目录后菜单应保持打开');
    assert.deepEqual(next.items, ['src/tui/app.ts']);
  });

  it('mentionQuery:空索引下也能识别 @ 词条,供上层决定是否扫描', () => {
    const editor = new InputEditor({ files: () => [] });
    editor.insert('@');
    // 空索引不会有候选,但词条查询必须可见——否则上层拿不到扫描的触发依据
    assert.equal(editor.mentionQuery(), '');
    const empty = editor.completionState;
    assert.equal(empty, null);
    editor.insert('ap');
    assert.equal(editor.mentionQuery(), 'ap');
  });

  it('mentionQuery:非词首的 @ 不算词条', () => {
    const editor = new InputEditor({ files: () => ['src/a.ts'] });
    editor.insert('mail me@example.com');
    assert.equal(editor.mentionQuery(), null);
  });

  it('mentionQuery:光标离开词条后返回 null', () => {
    const editor = new InputEditor({ files: () => ['src/a.ts'] });
    editor.insert('@src/a.ts ');
    assert.equal(editor.mentionQuery(), null);
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
