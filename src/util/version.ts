import { createRequire } from 'node:module';

/**
 * Reins 版本号:唯一来源是 package.json。
 *
 * 设计意图:版本号此前硬编码在命令行输出与 MCP 客户端标识里,发版时容易漏改、
 * 出现同一个二进制报出两个版本。这里读一次并缓存,所有展示点共用;
 * 读不到时退化为 0.0.0,而不是让进程起不来。
 */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
