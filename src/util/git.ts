import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * git 仓库探测与分支操作。
 *
 * 设计意图:读的部分尽量不起进程——header 每帧都要分支名,靠读 .git 文本文件取值
 * 比调用 git 便宜两个数量级。只有必须改变仓库状态的操作(切换分支)与必须靠 git
 * 才能算清的判定(未提交改动)才起子进程,且一律用 execFile 传参数数组、
 * 不经 shell:分支名来自仓库自身,仍不给它拼命令的机会。
 */

/**
 * 读取工作区所在仓库的当前分支。
 *
 * 支持从子目录向上找仓库根,以及 worktree / submodule(.git 是文本文件的情形)。
 * 不是仓库或读取失败返回 undefined;分离头指针返回短提交号,比什么都不显示有用。
 */
export async function readGitBranch(workspace: string): Promise<string | undefined> {
  const gitDir = await findGitDir(workspace);
  if (gitDir === undefined) {
    return undefined;
  }
  const content = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => undefined);
  if (content === undefined) {
    return undefined;
  }
  const trimmed = content.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(trimmed);
  if (ref !== null) {
    return (ref[1] ?? '').trim();
  }
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed.slice(0, 7) : undefined;
}

/**
 * 列出本地分支:refs/heads 目录与 packed-refs 取并集,按名称排序。
 *
 * 不跑 `git branch --list`:分支下拉要随移动事件秒级重绘,读文件比起进程合适。
 * 不是仓库或读不到时返回空数组——界面据此把「无分支」当作「不可切换」处理。
 */
export async function listLocalBranches(workspace: string): Promise<string[]> {
  const gitDir = await findGitDir(workspace);
  if (gitDir === undefined) {
    return [];
  }
  const names = new Set(await readLooseBranches(join(gitDir, 'refs', 'heads')));
  const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8').catch(() => undefined);
  if (packed !== undefined) {
    for (const name of parsePackedBranches(packed)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** 解析 packed-refs:只取 refs/heads 下的分支,忽略注释行与 peeled 行。 */
export function parsePackedBranches(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^[0-9a-f]{40}\s+refs\/heads\/(.+)$/.exec(line.trim());
    if (match !== null) {
      names.push((match[1] ?? '').trim());
    }
  }
  return names;
}

/** 工作区是否有未提交改动;git 报错时按「有改动」处理,宁可拒绝切换。 */
export async function hasUncommittedChanges(workspace: string): Promise<boolean> {
  const result = await runGit(workspace, ['status', '--porcelain']);
  if (result.code !== 0) {
    return true;
  }
  return result.stdout.trim() !== '';
}

/**
 * 切换分支。失败时把 git 的 stderr 原样带回,界面直接能读懂原因
 * (switch 会说明「会被本地改动覆盖」之类)。
 *
 * 用 git switch 而非 `checkout -- <名字>`:后者的 `--` 让参数被当成路径,
 * 而 switch 的参数只可能是分支,不会被同名文件歧义掉。
 */
export async function checkoutBranch(
  workspace: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await runGit(workspace, ['switch', branch]);
  if (result.code === 0) {
    return { ok: true };
  }
  const message = (result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()).trim();
  return { ok: false, message: message === '' ? `git checkout ${branch} 失败` : message };
}

/** 跑一条 git 子命令,拿到退出码与两个输出流;进程起不来按失败处理。 */
function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolvePromise({ code, stdout, stderr: error === null ? stderr : stderr || error.message });
    });
  });
}

/** 递归读 refs/heads 下的分支名;嵌套目录用 / 连接(git 的层级分支写法)。 */
async function readLooseBranches(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    // 相对 refs/heads 根目录算,才留得住 feature/login 这层层级
    names.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return names;
}

/** 自工作区向上查找 .git 目录;.git 为文件时按 gitdir 指向继续找。 */
async function findGitDir(start: string): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    const marker = join(dir, '.git');
    const info = await stat(marker).catch(() => undefined);
    if (info !== undefined) {
      if (info.isDirectory()) {
        return marker;
      }
      if (info.isFile()) {
        const text = await readFile(marker, 'utf8').catch(() => '');
        const match = /^gitdir:\s*(.+)$/m.exec(text.trim());
        return match === null ? undefined : resolve(dir, (match[1] ?? '').trim());
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
