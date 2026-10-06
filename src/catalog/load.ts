import { ConfigError } from '../util/errors.ts';
import { pathExists, readTextFile } from '../util/fsx.ts';
import { parseCatalog, type Catalog, type ModelSpec, type ProviderSpec } from './schema.ts';
import { defaultSecretContext, resolveValue, type SecretContext } from './secrets.ts';

/**
 * providers.json 的加载与解析。
 *
 * 设计意图:加载与「按名解析」分离——加载负责把文件变成目录;
 * 解析负责把「provider/model 名字」变成具体声明,并给出可行动的报错。
 */

/** 从指定文件加载并校验 providers.json。 */
export async function loadCatalogFile(file: string): Promise<Catalog> {
  if (!(await pathExists(file))) {
    throw new ConfigError(
      `未找到产商目录:${file}`,
      '运行 `reins init` 生成初始模板,或手动创建该文件。',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readTextFile(file));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${file} 解析失败:JSON 语法错误`, detail);
  }
  return parseCatalog(raw, file);
}

/** 按名解析 provider,找不到时列出已声明的候选。 */
export function resolveProvider(catalog: Catalog, name: string): ProviderSpec {
  const provider = catalog.providers[name];
  if (provider === undefined) {
    const available = Object.keys(catalog.providers);
    throw new ConfigError(
      `providers.json 中没有名为 "${name}" 的 provider`,
      available.length > 0 ? `已声明:${available.join('、')}` : '请先在 providers.json 中声明。',
    );
  }
  return provider;
}

/** 在 provider 内按 id 解析模型,找不到时列出候选。 */
export function resolveModel(provider: ProviderSpec, providerName: string, modelId: string): ModelSpec {
  const model = provider.models.find((item) => item.id === modelId);
  if (model === undefined) {
    const available = provider.models.map((item) => item.id);
    throw new ConfigError(
      `provider "${providerName}" 中没有名为 "${modelId}" 的模型`,
      available.length > 0 ? `可用:${available.join('、')}` : undefined,
    );
  }
  return model;
}

export interface ResolvedAuth {
  apiKey?: string;
  headers: Record<string, string>;
}

/** 解析 API key 与 headers(允许其中使用 $ENV / !command)。 */
export async function resolveAuth(
  provider: ProviderSpec,
  providerName: string,
  ctx: SecretContext = defaultSecretContext,
): Promise<ResolvedAuth> {
  const apiKey =
    provider.apiKey === undefined
      ? undefined
      : await resolveValue(provider.apiKey, `provider "${providerName}" 的 apiKey`, ctx);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(provider.headers ?? {})) {
    headers[key] = await resolveValue(
      value,
      `provider "${providerName}" 的 header "${key}"`,
      ctx,
    );
  }
  return { apiKey, headers };
}
