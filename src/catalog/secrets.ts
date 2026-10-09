import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigError } from '../util/errors.ts';

const execAsync = promisify(execCallback);

/**
 * 密钥解析:支持三种形态——`$ENV` 环境变量引用、`!command` 请求时执行、字面量。
 *
 * 设计意图:解析过程纯函数化(环境与命令执行都可注入),
 * 命令形式「请求时执行、不缓存」,避免密钥落盘或被长期驻留。
 */

export interface SecretContext {
  env: Record<string, string | undefined>;
  run(command: string): Promise<string>;
}

/** 默认上下文:读取真实环境变量,并以子进程执行命令。 */
export const defaultSecretContext: SecretContext = {
  env: process.env,
  async run(command: string): Promise<string> {
    const { stdout } = await execAsync(command, { timeout: 30_000 });
    return stdout.trim();
  },
};

/** 把 `$NAME` 或 `${NAME}` 解析为环境变量名;不是引用时返回 null。 */
export function parseEnvReference(value: string): string | null {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (!match) {
    return null;
  }
  return match[1] ?? match[2] ?? null;
}

/** 解析单个值;label 用于错误信息中指明来源。 */
export async function resolveValue(
  value: string,
  label: string,
  ctx: SecretContext = defaultSecretContext,
): Promise<string> {
  const trimmed = value.trim();
  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    if (command === '') {
      throw new ConfigError(`${label} 的命令为空`, '"!" 后应跟可执行命令。');
    }
    let output: string;
    try {
      output = await ctx.run(command);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`${label} 的命令执行失败:${detail}`, '检查命令是否存在、是否可执行。');
    }
    if (output === '') {
      throw new ConfigError(`${label} 的命令输出为空`, '命令应输出密钥内容。');
    }
    return output;
  }

  const envName = parseEnvReference(trimmed);
  if (envName !== null) {
    const found = ctx.env[envName];
    if (found === undefined || found === '') {
      throw new ConfigError(
        `${label} 引用的环境变量 ${envName} 未设置或为空`,
        `先设置环境变量,例如:export ${envName}=your-key`,
      );
    }
    return found;
  }

  // 字面量形态:也去首尾空白,避免 "  sk-xxx  " 把空格带进请求头
  return value.trim();
}
