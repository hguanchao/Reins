import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';
import {
  SESSION_FORMAT_VERSION,
  SessionStore,
  encodeProjectDir,
  type SessionEntry,
} from '../../src/session/store.ts';
import { readTextFile, writeTextFile } from '../../src/util/fsx.ts';

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
});
