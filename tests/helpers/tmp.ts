import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 创建测试用临时目录。 */
export async function createTmpDir(prefix = 'reins-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 删除临时目录,忽略不存在的情况。 */
export async function removeTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
