import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';
import {
  SESSION_FORMAT_VERSION,
  SessionStore,
  deleteSession,
  encodeProjectDir,
  renameSession,
  summarizeSessionFile,
  type SessionEntry,
} from '../../src/session/store.ts';
import { spillDirFor } from '../../src/spill/store.ts';
import { pathExists, readTextFile, writeTextFile } from '../../src/util/fsx.ts';

/** 会话 id 是裸 UUID v7:版本位 7、variant 8/9/a/b。 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeEntry(partial: Partial<SessionEntry> & Pick<SessionEntry, 'id' | 'type'>): SessionEntry {
  return {
    parentId: null,
    ts: new Date().toISOString(),
    text: '',
    ...partial,
  } as SessionEntry;
}

describe('会话存储', () => {
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('创建会话时写入带版本号的 meta 行', async () => {
    const store = await SessionStore.create(dir, process.cwd());
    const text = await readTextFile(store.file);
    const meta = JSON.parse(text.split('\n')[0] as string) as Record<string, unknown>;
    assert.equal(meta['v'], SESSION_FORMAT_VERSION);
    assert.equal(meta['type'], 'meta');
    assert.match(store.sessionId, SESSION_ID);
    assert.ok(store.file.includes(encodeProjectDir(process.cwd())));
  });

  it('追加条目后可完整读回且父子链正确', async () => {
    const store = await SessionStore.create(dir, process.cwd());
    await store.append(makeEntry({ id: 'e1', type: 'user', text: '你好' }));
    await store.append(makeEntry({ id: 'e2', type: 'assistant', text: '收到', parentId: 'e1' }));
    const { meta, entries } = await store.readAll();
    assert.equal(meta.sessionId, store.sessionId);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.parentId, 'e1');
  });

  it('打开已有文件后可以继续追加', async () => {
    const created = await SessionStore.create(dir, process.cwd());
    await created.append(makeEntry({ id: 'e1', type: 'user', text: 'x' }));
    const reopened = await SessionStore.open(created.file);
    assert.equal(reopened.sessionId, created.sessionId);
    await reopened.append(makeEntry({ id: 'e2', type: 'assistant', text: 'y', parentId: 'e1' }));
    const { entries } = await reopened.readAll();
    assert.equal(entries.length, 2);
  });

  it('打开不存在的文件时报错', async () => {
    await assert.rejects(() => SessionStore.open(join(dir, 'missing.jsonl')), /不存在/);
  });

  it('损坏的行报出具体行号', async () => {
    const file = join(dir, 'broken.jsonl');
    const meta = { v: 1, type: 'meta', sessionId: 's-x', createdAt: '', cwd: '' };
    await writeTextFile(file, `${JSON.stringify(meta)}\nnot-json\n`);
    const store = new SessionStore(file);
    await assert.rejects(() => store.readAll(), /第 2 行/);
  });

  it('文件里有空行时行号仍与编辑器一致', async () => {
    const file = join(dir, 'blank-lines.jsonl');
    const meta = { v: 1, type: 'meta', sessionId: 's-x', createdAt: '', cwd: '' };
    await writeTextFile(file, `${JSON.stringify(meta)}\n\nnot-json\n`);
    const store = new SessionStore(file);
    await assert.rejects(() => store.readAll(), /第 3 行/);
  });

  it('meta 行是 null 时报可读错误,而不是 TypeError', async () => {
    const file = join(dir, 'null-meta.jsonl');
    await writeTextFile(file, 'null\n');
    const store = new SessionStore(file);
    await assert.rejects(() => store.readAll(), /meta/);
  });

  it('格式版本过高时拒绝打开', async () => {
    const file = join(dir, 'future.jsonl');
    const meta = { v: 99, type: 'meta', sessionId: 's-x', createdAt: '', cwd: '' };
    await writeTextFile(file, `${JSON.stringify(meta)}\n`);
    const store = new SessionStore(file);
    await assert.rejects(() => store.readAll(), /版本/);
  });

  it('项目路径编码:盘符与分隔符都换成连字符', () => {
    assert.equal(encodeProjectDir('C:/work/a'), 'C--work-a');
    assert.equal(encodeProjectDir(String.raw`E:\Projects\Reins`), 'E--Projects-Reins');
  });

  it('会话按项目目录归档', async () => {
    const store = await SessionStore.create(dir, 'C:/work/demo');
    assert.ok(store.file.includes('C--work-demo'));
    assert.ok(store.file.endsWith(`${store.sessionId}.jsonl`), '文件名就是会话 id');
  });

  it('重命名只改 meta 行,条目与后续追加都不受影响', async () => {
    const store = await SessionStore.create(dir, process.cwd());
    await store.append(makeEntry({ id: 'e1', type: 'user', text: '你好' }));
    const entryLine = (await readTextFile(store.file)).split('\n')[1];

    await renameSession(store.file, '  排查登录超时  ');
    assert.equal((await summarizeSessionFile(store.file)).title, '排查登录超时', '标题去掉首尾空白');
    assert.equal((await readTextFile(store.file)).split('\n')[1], entryLine, '条目行原样保留');

    await store.append(makeEntry({ id: 'e2', type: 'assistant', text: '收到', parentId: 'e1' }));
    assert.equal((await store.readAll()).entries.length, 2);
  });

  it('空标题即清除,列表退回显示首条消息', async () => {
    const store = await SessionStore.create(dir, process.cwd());
    await renameSession(store.file, '临时名字');
    await renameSession(store.file, '   ');
    assert.equal((await summarizeSessionFile(store.file)).title, undefined);
    const meta = JSON.parse((await readTextFile(store.file)).split('\n')[0] as string) as Record<string, unknown>;
    assert.equal('title' in meta, false, '清除要真的把字段删掉,而不是留个空串');
  });

  it('重命名损坏文件时报可读错误', async () => {
    const file = join(dir, 'rename-broken.jsonl');
    await writeTextFile(file, 'not-json\n');
    await assert.rejects(() => renameSession(file, 'x'), /不是合法 JSON/);
  });

  it('删除会话时连落盘目录一起清掉', async () => {
    const store = await SessionStore.create(dir, process.cwd());
    await store.append(makeEntry({ id: 'e1', type: 'user', text: 'hi' }));
    const spillDir = spillDirFor(store.file, store.sessionId);
    await writeTextFile(join(spillDir, 'result.txt'), '很长的工具输出');

    await deleteSession(store.file);
    assert.equal(await pathExists(store.file), false);
    assert.equal(await pathExists(spillDir), false, '落盘目录不能留下孤儿');
  });
});
