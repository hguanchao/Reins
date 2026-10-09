import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';
import { Session } from '../../src/session/tree.ts';
import type { SessionEntry } from '../../src/session/store.ts';
import { writeTextFile } from '../../src/util/fsx.ts';

function textOf(entry: SessionEntry): string | undefined {
  return 'text' in entry ? entry.text : undefined;
}

describe('会话树', () => {
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('追加形成链条,活动分支按根到叶排序', async () => {
    const session = await Session.create(dir, process.cwd());
    await session.append({ type: 'user', text: '任务' });
    await session.append({ type: 'assistant', text: '开始', toolCalls: [] });
    await session.append({
      type: 'tool_result',
      toolCallId: 't1',
      name: 'read',
      content: '文件内容',
      isError: false,
    });
    const branch = session.activeBranch();
    assert.deepEqual(
      branch.map((entry) => entry.type),
      ['user', 'assistant', 'tool_result'],
    );
    assert.equal(branch[0]?.parentId, null);
    assert.equal(branch[2]?.parentId, branch[1]?.id);
  });

  it('branchFrom 之后形成新分支,旧分支保留', async () => {
    const session = await Session.create(dir, process.cwd());
    const first = await session.append({ type: 'user', text: 'u1' });
    const second = await session.append({ type: 'assistant', text: 'a1', toolCalls: [] });
    await session.append({ type: 'assistant', text: 'a2', toolCalls: [] });
    session.branchFrom(second.id);
    await session.append({ type: 'assistant', text: 'b1', toolCalls: [] });

    const branch = session.activeBranch();
    assert.deepEqual(branch.map(textOf), ['u1', 'a1', 'b1']);
    assert.equal(session.allEntries.length, 4);
    assert.equal(first.parentId, null);
  });

  it('切换到未知条目时报错', async () => {
    const session = await Session.create(dir, process.cwd());
    assert.throws(() => session.branchFrom('nope'), /找不到条目/);
  });

  it('恢复会话时叶子指向最后一条', async () => {
    const session = await Session.create(dir, process.cwd());
    await session.append({ type: 'user', text: 'x' });
    const last = await session.append({ type: 'assistant', text: 'y', toolCalls: [] });
    const resumed = await Session.resume(session.path);
    assert.equal(resumed.leaf, last.id);
    assert.equal(resumed.activeBranch().length, 2);
    assert.equal(resumed.id, session.id);
  });

  it('文件被篡改出父子环时不会死循环', async () => {
    const file = join(dir, 'cyclic.jsonl');
    const meta = { v: 1, type: 'meta', sessionId: 's-cycle', createdAt: '', cwd: '' };
    const e1 = { id: 'e1', parentId: 'e2', ts: '', type: 'user', text: 'a' };
    const e2 = { id: 'e2', parentId: 'e1', ts: '', type: 'assistant', text: 'b', toolCalls: [] };
    await writeTextFile(file, `${JSON.stringify(meta)}\n${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);
    const session = await Session.resume(file);
    // 若没有环检测,这里会一直向上追溯;有检测则正常终止
    assert.equal(session.activeBranch().length, 2);
  });
});
