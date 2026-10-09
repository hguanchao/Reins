import { join } from 'node:path';
import { pathExists } from '../util/fsx.ts';
import { ConfigError } from '../util/errors.ts';
import { reinsHome } from '../util/paths.ts';
import { loadConfigFile, readTomlFile } from './load.ts';
import { parseConfig, type Config } from './schema.ts';

/**
 * 配置分层:全局(~/.reins/config.toml)之上叠加项目层(<cwd>/.reins/config.toml)。
 *
 * 设计意图:合并发生在「原始对象」层——先深度合并再统一校验,
 * 这样默认值不会掩盖项目层的覆盖意图,校验也只做一次。
 */

export interface LayeredConfig {
  config: Config;
  /** 参与本次加载的文件,按层级从低到高排列。 */
  files: string[];
}

/** 以 override 覆盖 base 的深度合并;数组与标量整体替换。 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 跳过原型链上的危险键:TOML 里写 __proto__ 会触发 setter,污染 Object.prototype
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    const previous = result[key];
    if (isPlainObject(previous) && isPlainObject(value)) {
      result[key] = deepMerge(previous, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface LoadLayeredOptions {
  home?: string;
  cwd?: string;
  /**
   * 是否加载项目层(<cwd>/.reins/config.toml)。
   *
   * 必填且无默认:项目层能覆盖审批、沙箱、权限与 MCP,漏传必须编译失败而不是静默放行。
   * 取值由 config/trust.ts 的信任判定给出。
   */
  projectLayer: 'allow' | 'ignore';
}

/** 加载分层配置;全局层必须存在,项目层可选且须被信任。 */
export async function loadLayeredConfig(options: LoadLayeredOptions): Promise<LayeredConfig> {
  const home = options.home ?? reinsHome();
  const cwd = options.cwd ?? process.cwd();
  const globalFile = join(home, 'config.toml');
  const projectFile = join(cwd, '.reins', 'config.toml');

  const globalRaw = await readTomlFile(globalFile);
  if (options.projectLayer === 'ignore' || !(await pathExists(projectFile))) {
    return { config: parseConfig(globalRaw, globalFile), files: [globalFile] };
  }
  const projectRaw = await readTomlFile(projectFile);
  // 项目层不得声明信任:否则仓库可以给自己授权,信任判定就形同虚设
  if (projectRaw['trust'] !== undefined) {
    throw new ConfigError(
      `${projectFile} 声明了 [trust]`,
      '信任只能写在全局 ~/.reins/config.toml 里;请把该项目从项目层的 [trust] 中移除。',
    );
  }
  const merged = deepMerge(globalRaw, projectRaw);
  return { config: parseConfig(merged, `${globalFile} + ${projectFile}`), files: [globalFile, projectFile] };
}

/** 供 doctor 等场景使用:只加载单文件(全局),不做分层。 */
export async function loadSingleConfig(home: string): Promise<Config> {
  return loadConfigFile(join(home, 'config.toml'));
}
