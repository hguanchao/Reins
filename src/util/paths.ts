import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/**
 * 路径处理的统一入口。
 *
 * 设计意图:路径相关的边界判断(尤其是"是否在工作区内")是安全性的根基,
 * 因此集中在此处实现,避免散落各处的字符串比较。
 */

/**
 * Reins 主目录:固定 `~/.reins`,不提供环境变量或命令行出口。
 *
 * 为什么固定:这个目录里同时放着 `[trust].trusted` 授权记录与端点密钥。若允许
 * REINS_HOME 之类的外移,同一份工作区在不同启动环境下就会命中不同的信任与凭据,
 * 授权面不再只有一份;固定路径让「谁被信任、用哪把密钥」始终可由同一个文件回答。
 */
export function reinsHome(): string {
  return join(homedir(), '.reins');
}

/** 展开开头的 ~ 为用户主目录。 */
export function expandHome(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** 转为绝对路径并消除冗余片段。 */
export function absolutize(input: string, base: string = process.cwd()): string {
  const expanded = expandHome(input);
  return normalize(isAbsolute(expanded) ? expanded : resolve(base, expanded));
}

/** 判断 child 是否位于 parent 之内(Windows 下忽略大小写)。 */
export function isWithin(parent: string, child: string): boolean {
  const parentPath = absolutize(parent);
  const childPath = absolutize(child);
  const rel = relative(parentPath, childPath);
  if (rel === '') {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  return !rel.startsWith(`..${sep}`) && rel !== '..';
}

/** 生成用于展示的相对路径,统一使用 / 分隔。 */
export function displayPath(target: string, base: string = process.cwd()): string {
  const rel = relative(absolutize(base), absolutize(target));
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/** 反斜杠统一成正斜杠,便于跨平台比较路径字符串。 */
export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/** 判断模式是否形如绝对路径(/ 开头或盘符开头);不接触文件系统。 */
export function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

