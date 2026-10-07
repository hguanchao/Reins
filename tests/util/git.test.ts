import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readGitBranch } from '../../src/util/git.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

describe('git 分支探测', () => {
  let dir = '';

  before(async () => {
    dir = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(dir);
  });

  /** 造一个仓库:repo/.git/HEAD 写入 head 内容,返回仓库根。 */
  async function makeRepo(name: string, head: string): Promise<string> {
    const root = join(dir, name);
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), head);
    return root;
  }

  it('读取当前分支', async () => {
    const root = await makeRepo('plain', 'ref: refs/heads/main\n');
    assert.equal(await readGitBranch(root), 'main');
  });

  it('分支名里的斜杠保留', async () => {
    const root = await makeRepo('slashed', 'ref: refs/heads/feature/login\n');
    assert.equal(await readGitBranch(root), 'feature/login');
  });

  it('从子目录向上找到仓库根', async () => {
    const root = await makeRepo('nested', 'ref: refs/heads/dev\n');
    const deep = join(root, 'src', 'tui');
    await mkdir(deep, { recursive: true });
    assert.equal(await readGitBranch(deep), 'dev');
  });

  it('分离头指针给短提交号', async () => {
    const root = await makeRepo('detached', '0123456789abcdef0123456789abcdef01234567\n');
    assert.equal(await readGitBranch(root), '0123456');
  });

  it('不是仓库或 HEAD 异常时返回 undefined', async () => {
    const bare = join(dir, 'no-repo');
    await mkdir(bare, { recursive: true });
    assert.equal(await readGitBranch(bare), undefined);
    // HEAD 内容既不是 ref 也不是提交号
    const broken = await makeRepo('broken', '这不是 HEAD\n');
    assert.equal(await readGitBranch(broken), undefined);
  });

  it('.git 是文件(worktree / submodule)时按 gitdir 继续找', async () => {
    const real = await makeRepo('real', 'ref: refs/heads/worktree-branch\n');
    const linked = join(dir, 'linked');
    await mkdir(linked, { recursive: true });
    await writeFile(join(linked, '.git'), `gitdir: ${join(real, '.git')}\n`);
    assert.equal(await readGitBranch(linked), 'worktree-branch');
  });
});
