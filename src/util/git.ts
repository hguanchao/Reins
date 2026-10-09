import { dirname, join, resolve } from 'node:path';
import { isDirectory, isFile, readTextFile } from './fsx.ts';

/**
 * 读取工作区所在仓库的当前分支。
 *
 * 为什么直接读 `.git/HEAD`:状态栏只为一行字,起一个 git 子进程不值当;
 * HEAD 本身就是一个文本文件——`ref: refs/heads/<分支>`,或分离头指针时的一串提交号。
 *
 * 三种情形都要认:
 * - 常规仓库:`.git` 是目录;
 * - worktree / submodule:`.git` 是文件,内容为 `gitdir: <路径>`;
 * - 在工作区的子目录里启动:向上找最近的仓库根。
 *
 * 任何一步读不到或读不懂都返回 undefined(不是仓库、权限不足、HEAD 内容异常),
 * 由调用方决定怎么呈现——状态栏据此整项省略,不影响其余内容。
 */
export async function readGitBranch(workspace: string): Promise<string | undefined> {
  const gitDir = await findGitDir(resolve(workspace));
  if (gitDir === undefined) {
    return undefined;
  }
  let head: string;
  try {
    head = await readTextFile(join(gitDir, 'HEAD'));
  } catch {
    return undefined;
  }
  const value = head.trim();
  if (value === '') {
    return undefined;
  }
  if (!value.startsWith(REF_KEY)) {
    // 分离头指针:HEAD 里是提交号,显示短号比显示 "HEAD" 有用
    return shorten(value);
  }
  const ref = value.slice(REF_KEY.length).trim();
  if (ref === '') {
    return undefined;
  }
  // 分支引用去掉前缀;其余引用(标签等)留短名
  if (ref.startsWith(BRANCH_PREFIX)) {
    const name = ref.slice(BRANCH_PREFIX.length);
    // 名字为空说明 HEAD 被写坏了,宁可整项不显示也不要挂一个空的「🌿 」
    return name === '' ? undefined : name;
  }
  return shorten(ref);
}

/** 解析 `.git` 文件里的 `gitdir:` 行;路径相对该文件所在目录。 */
export function parseGitDir(content: string): string | undefined {
  for (const row of content.split('\n')) {
    if (!row.trimStart().startsWith(GITDIR_KEY)) {
      continue;
    }
    const target = row.slice(row.indexOf(':') + 1).trim();
    return target === '' ? undefined : target;
  }
  return undefined;
}

/** HEAD 里指向引用的前缀;后面可能跟着空白,故只认冒号本身。 */
const REF_KEY = 'ref:';
const BRANCH_PREFIX = 'refs/heads/';
const GITDIR_KEY = 'gitdir:';
/** 分离头指针展示的提交号长度。 */
const SHORT_LENGTH = 7;

/** 从起始目录向上找到最近的仓库,返回可读 HEAD 的目录。 */
async function findGitDir(start: string): Promise<string | undefined> {
  let current = start;
  for (;;) {
    const candidate = join(current, '.git');
    if (await isDirectory(candidate)) {
      return candidate;
    }
    if (await isFile(candidate)) {
      let content: string;
      try {
        content = await readTextFile(candidate);
      } catch {
        return undefined;
      }
      const target = parseGitDir(content);
      return target === undefined ? undefined : resolve(current, target);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** 取前若干位,短于该长度时原样返回。 */
function shorten(value: string): string {
  return value.length > SHORT_LENGTH ? value.slice(0, SHORT_LENGTH) : value;
}
