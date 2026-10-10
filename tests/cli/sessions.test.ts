import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { latestSessionFile, listSessionSummaries, resolveSessionFile, sessionsCommand } from '../../src/cli/commands/sessions.ts';
import { Session } from '../../src/session/tree.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

function captureLines(): {
  lines: string[];
  io: { out: (t: string) => void; err: (t: string) => void };
} {
  const lines: string[] = [];
  return { lines, io: { out: (t) => void lines.push(t), err: (t) => void lines.push(t) } };
}

describe('sessions 子命令', () => {
  let home = '';

  before(async () => {
    home = await createTmpDir();
    const dir = join(home, 'sessions');
    const first = await Session.create(dir, 'C:/work/a');
    await first.append({ type: 'user', text: '修复登录页面的错别字' });
    await first.append({ type: 'assistant', text: '好的', toolCalls: [] });
    const second = await Session.create(dir, 'C:/work/b');
    await second.append({ type: 'user', text: '生成 changelog' });
  });

  after(async () => {
    await removeTmpDir(home);
  });

  it('list 输出会话摘要', async () => {
    const { lines, io } = captureLines();
    const code = await sessionsCommand({ command: 'sessions', positionals: ['list'], flags: {} }, io, home);
    assert.equal(code, 0);
    const all = lines.join('\n');
    assert.ok(all.includes('修复登录页面的错别字'));
    assert.ok(all.includes('生成 changelog'));
    assert.ok(all.includes('共 2 个会话'));
  });

  it('resolveSessionFile 支持 id 前缀解析', async () => {
    const isolated = await createTmpDir();
    try {
      const session = await Session.create(join(isolated, 'sessions'), 'C:/x');
      const resolved = await resolveSessionFile(isolated, session.id.slice(0, 8));
      assert.equal(resolved, session.path);
      const full = await resolveSessionFile(isolated, session.id);
      assert.equal(full, session.path);
    } finally {
      await removeTmpDir(isolated);
    }
  });

  it('未知引用报出可行动错误', async () => {
    await assert.rejects(() => resolveSessionFile(home, 'no-such-session'), /找不到会话/);
  });

  it('路径形式原样返回', async () => {
    assert.equal(await resolveSessionFile(home, 'E:/some/file.jsonl'), 'E:/some/file.jsonl');
  });

  it('latestSessionFile 返回最近更新的会话', async () => {
    const isolated = await createTmpDir();
    try {
      const first = await Session.create(join(isolated, 'sessions'), 'C:/a');
      await first.append({ type: 'user', text: '一' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await Session.create(join(isolated, 'sessions'), 'C:/b');
      await second.append({ type: 'user', text: '二' });
      assert.equal(await latestSessionFile(isolated), second.path);
    } finally {
      await removeTmpDir(isolated);
    }
  });

  it('latestSessionFile 在无会话时返回 undefined', async () => {
    const isolated = await createTmpDir();
    try {
      assert.equal(await latestSessionFile(isolated), undefined);
    } finally {
      await removeTmpDir(isolated);
    }
  });

  it('listSessionSummaries 不传 cwd 时列出全部项目', async () => {
    const summaries = await listSessionSummaries(home);
    assert.equal(summaries.length, 2);
    assert.deepEqual(
      [...summaries.map((summary) => summary.cwd)].sort(),
      ['C:/work/a', 'C:/work/b'],
    );
  });

  it('listSessionSummaries 按项目过滤后,列出的会话必定可恢复', async () => {
    const scoped = await listSessionSummaries(home, 'C:/work/a');
    assert.equal(scoped.length, 1);
    const mine = scoped[0];
    assert.ok(mine);
    assert.equal(mine.cwd, 'C:/work/a');
    // 同一个 id:在本项目里解析得到,在另一个项目里就该报找不到——
    // 菜单若不做这层过滤,列出来的正是这种点了报错的会话
    assert.equal(await resolveSessionFile(home, mine.sessionId, 'C:/work/a'), mine.file);
    await assert.rejects(
      () => resolveSessionFile(home, mine.sessionId, 'C:/work/b'),
      /找不到会话/,
    );
  });

  it('按项目过滤:目录名碰撞时不会取到别的项目的会话', async () => {
    const isolated = await createTmpDir();
    try {
      const dir = join(isolated, 'sessions');
      // 这两个 cwd 编码后落到同一个目录(C--a-b),正是目录名不单射的场景
      const dash = await Session.create(dir, 'C:/a-b');
      await dash.append({ type: 'user', text: 'dash 项目' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const nested = await Session.create(dir, 'C:/a/b');
      await nested.append({ type: 'user', text: 'nested 项目' });

      // 不做项目过滤时最近的是 nested;指定项目后各自取回自己的会话
      assert.equal(await latestSessionFile(isolated), nested.path);
      assert.equal(await latestSessionFile(isolated, 'C:/a-b'), dash.path);
      assert.equal(await latestSessionFile(isolated, 'C:/a/b'), nested.path);

      // 前缀解析同样限定在指定项目内:nested 的会话在 dash 项目里应找不到
      assert.equal(await resolveSessionFile(isolated, nested.id, 'C:/a/b'), nested.path);
      await assert.rejects(
        () => resolveSessionFile(isolated, nested.id, 'C:/a-b'),
        /找不到会话/,
      );
    } finally {
      await removeTmpDir(isolated);
    }
  });
});
