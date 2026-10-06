import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveSessionFile, sessionsCommand } from '../../src/cli/commands/sessions.ts';
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
  const previous = process.env['REINS_HOME'];

  before(async () => {
    home = await createTmpDir();
    process.env['REINS_HOME'] = home;
    const dir = join(home, 'sessions');
    const first = await Session.create(dir, 'C:/work/a');
    await first.append({ type: 'user', text: '修复登录页面的错别字' });
    await first.append({ type: 'assistant', text: '好的', toolCalls: [] });
    const second = await Session.create(dir, 'C:/work/b');
    await second.append({ type: 'user', text: '生成 changelog' });
  });

  after(async () => {
    if (previous === undefined) {
      delete process.env['REINS_HOME'];
    } else {
      process.env['REINS_HOME'] = previous;
    }
    await removeTmpDir(home);
  });

  it('list 输出会话摘要', async () => {
    const { lines, io } = captureLines();
    const code = await sessionsCommand({ command: 'sessions', positionals: ['list'], flags: {} }, io);
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
});
