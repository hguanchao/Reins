import { join } from 'node:path';
import { pathExists, writeTextFile } from '../util/fsx.ts';
import { DEFAULT_CONFIG_TOML, DEFAULT_PROVIDERS_JSON } from './templates.ts';

/**
 * 启动时自动补全:缺失的配置文件用内置模板创建,已存在的绝不覆盖。
 *
 * 设计意图:首次运行不出现「文件不存在」的冷启动错误,
 * 而是给出可编辑的完整模板;所有创建行为都上报给调用方展示。
 */

export interface EnsureResult {
  /** 本次新建的文件路径;为空表示无需补全。 */
  created: string[];
}

export async function ensureHomeConfig(home: string): Promise<EnsureResult> {
  const created: string[] = [];
  const configFile = join(home, 'config.toml');
  const providersFile = join(home, 'providers.json');

  if (!(await pathExists(configFile))) {
    await writeTextFile(configFile, DEFAULT_CONFIG_TOML);
    created.push(configFile);
  }
  if (!(await pathExists(providersFile))) {
    await writeTextFile(providersFile, DEFAULT_PROVIDERS_JSON);
    created.push(providersFile);
  }
  return { created };
}
