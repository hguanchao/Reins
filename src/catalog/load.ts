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

/** 按名查找 provider(大小写不敏感);返回规范名称与声明。 */
export function findProvider(
  catalog: Catalog,
  name: string,
): { name: string; spec: ProviderSpec } | undefined {
  const direct = catalog.providers[name];
  if (direct !== undefined) {
    return { name, spec: direct };
  }
  const lower = name.toLowerCase();
  for (const [key, spec] of Object.entries(catalog.providers)) {
    if (key.toLowerCase() === lower) {
      return { name: key, spec };
    }
  }
  return undefined;
}

/** 按名解析 provider,找不到时列出已声明的候选。 */
export function resolveProvider(catalog: Catalog, name: string): ProviderSpec {
  const found = findProvider(catalog, name);
  if (found === undefined) {
    const available = Object.keys(catalog.providers);
    throw new ConfigError(
      `providers.json 中没有名为 "${name}" 的 provider`,
      available.length > 0 ? `已声明:${available.join('、')}` : '请先在 providers.json 中声明。',
    );
  }
  return found.spec;
}

/** 模型引用解析结果(供 /model 等交互场景使用)。 */
export type ModelTargetMatch =
  | { kind: 'found'; provider: string; modelId: string }
  | { kind: 'ambiguous'; options: { provider: string; modelId: string }[] }
  | { kind: 'none' };

/** 解析模型引用:"provider/model" 优先,其次在全部 provider 中按模型 id 搜索。 */
export function findModelTarget(catalog: Catalog, query: string): ModelTargetMatch {
  const trimmed = query.trim();
  if (trimmed === '') {
    return { kind: 'none' };
  }
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const providerName = trimmed.slice(0, slash);
    const modelId = trimmed.slice(slash + 1);
    const provider = findProvider(catalog, providerName);
    if (provider !== undefined) {
      const model = provider.spec.models.find((item) => item.id === modelId);
      if (model !== undefined) {
        return { kind: 'found', provider: provider.name, modelId: model.id };
      }
    }
  }
  const options: { provider: string; modelId: string }[] = [];
  for (const [name, spec] of Object.entries(catalog.providers)) {
    for (const model of spec.models) {
      if (model.id === trimmed) {
        options.push({ provider: name, modelId: model.id });
      }
    }
  }
  if (options.length === 1) {
    return { kind: 'found', provider: options[0]!.provider, modelId: options[0]!.modelId };
  }
  if (options.length > 1) {
    return { kind: 'ambiguous', options };
  }
  return { kind: 'none' };
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
