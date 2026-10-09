import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * 解析路径的真实位置。
 *
 * 为什么需要:沙箱的「是否在工作区内」判定如果只看字面路径,工作区里的一个
 * 符号链接就能把写操作引到工作区之外(`<workspace>/link/passwd` 字面上在区内,
 * 实际写到链接指向的位置)。判定前先解析真实路径,才能让边界名副其实。
 *
 * 目标可能还不存在(新建文件),所以逐级向上找到第一个存在的祖先做 realpath,
 * 再把不存在的尾段拼回去;整条链都解析不了时退回字面绝对路径。
 */
export async function resolveRealPath(target: string): Promise<string> {
  const absolute = resolve(target);
  let current = absolute;
  const tail: string[] = [];

  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // 连根都不存在(理论上不会发生):退回字面路径,让沙箱按字面判定
        return absolute;
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}
