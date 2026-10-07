import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * git 仓库信息的只读探测。
 *
 * 设计意图:只读 .git/HEAD,不调用 git 子进程——header 需要频繁取值,
 * 起进程太贵;放在 util 与 walk / fsx 同类,只做文件系统原语,不认识业务概念。
 */

/**
 * 读取工作区所在仓库的当前分支。
 *
 * 支持从子目录向上找仓库根,以及 worktree / submodule(.git 是文本文件的情形)。
 * 不是仓库或读取失败返回 undefined;分离头指针返回短提交号,比什么都不显示有用。
 */
export async function readGitBranch(workspace: string): Promise<string | undefined> {
  const head = await findHeadFile(workspace);
  if (head === undefined) {
    return undefined;
  }
  const content = await readFile(head, 'utf8').catch(() => undefined);
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

/** 自工作区向上查找 .git/HEAD;.git 为文件时按 gitdir 指向继续找。 */
async function findHeadFile(start: string): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    const marker = join(dir, '.git');
    const info = await stat(marker).catch(() => undefined);
    if (info !== undefined) {
      if (info.isDirectory()) {
        return join(marker, 'HEAD');
      }
      if (info.isFile()) {
        const text = await readFile(marker, 'utf8').catch(() => '');
        const match = /^gitdir:\s*(.+)$/m.exec(text.trim());
        return match === null ? undefined : join(resolve(dir, (match[1] ?? '').trim()), 'HEAD');
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
