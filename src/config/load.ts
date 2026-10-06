import { parse as parseToml } from 'smol-toml';
import { pathExists, readTextFile } from '../util/fsx.ts';
import { ConfigError } from '../util/errors.ts';
import { parseConfig, type Config } from './schema.ts';

/** 读取并解析一个 TOML 文件为顶层对象;语法错误包装为用户可读的提示。 */
export async function readTomlFile(file: string): Promise<Record<string, unknown>> {
  if (!(await pathExists(file))) {
    throw new ConfigError(`未找到配置文件:${file}`, '运行 `reins init` 生成初始配置。');
  }
  let raw: unknown;
  try {
    raw = parseToml(await readTextFile(file));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${file} 解析失败:${detail}`, '请检查 TOML 语法(缩进、引号、逗号)。');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${file} 的顶层结构应为键值表`);
  }
  return raw as Record<string, unknown>;
}

/** 从指定文件加载并校验 config.toml(不处理分层)。 */
export async function loadConfigFile(file: string): Promise<Config> {
  const raw = await readTomlFile(file);
  return parseConfig(raw, file);
}
