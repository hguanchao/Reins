import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 文件系统访问的统一薄封装。
 *
 * 设计意图:把异步 IO 收敛到一处,调用方只关心语义;同时为测试预留可替换的边界。
 */

/** 判断路径是否存在。 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 读取文本文件。 */
export async function readTextFile(target: string): Promise<string> {
  return readFile(target, 'utf8');
}

/** 写入文本文件,自动创建父目录。 */
export async function writeTextFile(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

/** 追加一行文本,自动创建父目录。 */
export async function appendLine(target: string, line: string): Promise<void> {
  const { appendFile } = await import('node:fs/promises');
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${line}\n`, 'utf8');
}

/** 递归创建目录。 */
export async function ensureDir(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

/** 判断是否普通文件。 */
export async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
