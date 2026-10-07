import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BashTool } from '../../src/tools/bash.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('命令执行工具', () => {
  const tool = new BashTool();
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  it('执行命令并回传输出与退出码', async () => {
    const result = await tool.execute({ command: 'echo hello-reins' }, { workspace: dir });
    assert.equal(result.isError, false);
    assert.ok(result.content.includes('hello-reins'));
    assert.ok(result.content.includes('退出码:0'));
  });

  it('非零退出码不视为工具错误', async () => {
    const result = await tool.execute({ command: 'node -e "process.exit(3)"' }, { workspace: dir });
    assert.equal(result.isError, false);
    assert.ok(result.content.includes('退出码:3'));
  });

  it('stderr 被捕获', async () => {
    const result = await tool.execute(
      { command: 'node -e "console.error(\'oops\')"' },
      { workspace: dir },
    );
    assert.ok(result.content.includes('oops'));
  });

  it('超时后进程被终止', async () => {
    const started = Date.now();
    const result = await tool.execute(
      { command: 'node -e "setTimeout(() => console.log(\'late\'), 3000)"', timeout_ms: 400 },
      { workspace: dir },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2500, `超时未生效,耗时 ${elapsed}ms`);
    assert.equal(result.content.includes('late'), false);
    assert.ok(result.content.includes('执行超时'));
  });

  it('timeout_ms 非正数时回退默认超时,不立即杀进程', async () => {
    const zero = await tool.execute({ command: 'echo hi-zero', timeout_ms: 0 }, { workspace: dir });
    assert.equal(zero.isError, false);
    assert.ok(zero.content.includes('hi-zero'));
    assert.equal(zero.content.includes('执行超时'), false);
    const negative = await tool.execute(
      { command: 'echo hi-neg', timeout_ms: -5 },
      { workspace: dir },
    );
    assert.ok(negative.content.includes('hi-neg'));
    assert.equal(negative.content.includes('执行超时'), false);
  });

  it('targetOf 提取命令文本', () => {
    assert.deepEqual(tool.targetOf({ command: 'git status' }, { workspace: dir }), {
      command: 'git status',
    });
  });
});
