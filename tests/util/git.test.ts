import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseGitDir, readGitBranch } from '../../src/util/git.ts';
import { createTmpDir, removeTmpDir } from '../helpers/tmp.ts';

/** 造一个带 .git/HEAD 的仓库目录。 */
async function makeRepo(root: string, head: string): Promise<string> {
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), head, 'utf8');
  return root;
}

describe('读取 git 分支', () => {
  let root = '';

  before(async () => {
    root = await createTmpDir();
  });

  after(async () => {
    await removeTmpDir(root);
  });

  it('常规仓库:解析 ref 前缀取出分支名', async () => {
    const repo = await makeRepo(join(root, 'plain'), 'ref: refs/heads/main\n');
    assert.equal(await readGitBranch(repo), 'main');
  });

  it('带斜杠的分支名整段保留', async () => {
    const repo = await makeRepo(join(root, 'nested-branch'), 'ref: refs/heads/feature/tui\n');
    assert.equal(await readGitBranch(repo), 'feature/tui');
  });

  it('从子目录向上找到仓库根', async () => {
    const repo = await makeRepo(join(root, 'parent-repo'), 'ref: refs/heads/dev\n');
    const child = join(repo, 'src', 'deep');
    await mkdir(child, { recursive: true });
    assert.equal(await readGitBranch(child), 'dev');
  });

  it('分离头指针显示短提交号', async () => {
    const repo = await makeRepo(join(root, 'detached'), `${'a'.repeat(40)}\n`);
    assert.equal(await readGitBranch(repo), 'a'.repeat(7));
  });

  it('worktree:.git 是文件,按 gitdir 指向读 HEAD', async () => {
    const holder = join(root, 'worktree');
    const gitDir = join(holder, 'real-gitdir');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/worktree-branch\n', 'utf8');
    const worktree = join(holder, 'checkout');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
    assert.equal(await readGitBranch(worktree), 'worktree-branch');
  });

  it('worktree 的相对 gitdir 按 .git 文件所在目录解析', async () => {
    const holder = join(root, 'relative-worktree');
    const gitDir = join(holder, 'meta');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/relative\n', 'utf8');
    const worktree = join(holder, 'checkout');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: ../meta\n', 'utf8');
    assert.equal(await readGitBranch(worktree), 'relative');
  });

  it('不是仓库时返回 undefined', async () => {
    const plain = join(root, 'no-repo');
    await mkdir(plain, { recursive: true });
    assert.equal(await readGitBranch(plain), undefined);
  });

  it('HEAD 为空或内容异常时返回 undefined', async () => {
    const empty = await makeRepo(join(root, 'empty-head'), '\n');
    assert.equal(await readGitBranch(empty), undefined);

    const broken = join(root, 'broken-gitdir');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, '.git'), '不是 gitdir 行\n', 'utf8');
    assert.equal(await readGitBranch(broken), undefined);
  });

  it('gitdir 行解析:取冒号后的路径,空路径视为无效', () => {
    assert.equal(parseGitDir('gitdir: /repo/.git/worktrees/x\n'), '/repo/.git/worktrees/x');
    assert.equal(parseGitDir('gitdir:\n'), undefined);
    assert.equal(parseGitDir('随便一行\n'), undefined);
  });
});
