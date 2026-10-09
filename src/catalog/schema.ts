import { ConfigError } from '../util/errors.ts';
import { Checker } from '../util/schema.ts';

/**
 * providers.json 的形状定义与校验。
 *
 * 设计意图:端点是数据,协议是代码——这里只描述数据形状;
 * 每个 provider 条目必须自包含 baseUrl + api + models,缺一即报错。
 */

/** 当前代码支持的 wire 协议适配器集合。 */
export const SUPPORTED_APIS: readonly string[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: ModelCost;
  headers?: Record<string, string>;
}

export interface ProviderSpec {
  baseUrl: string;
  api: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: ModelSpec[];
}

export interface Catalog {
  providers: Record<string, ProviderSpec>;
}

/** 解析并校验原始对象;所有问题一次性汇总抛出。 */
export function parseCatalog(raw: unknown, file = 'providers.json'): Catalog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${file} 的顶层结构应为对象`, '产商目录是一个 JSON 对象,根键为 providers。');
  }
  const source = raw as Record<string, unknown>;
  const checker = new Checker(file);

  const providersTable = checker.object(source, 'providers', 'providers', { required: true });
  const providers: Record<string, ProviderSpec> = {};
  if (providersTable) {
    for (const [name, value] of Object.entries(providersTable)) {
      const path = `providers.${name}`;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        checker.fail(path, '应为对象');
        continue;
      }
      providers[name] = parseProvider(value as Record<string, unknown>, path, checker);
    }
  }

  checker.done();
  return { providers };
}

function parseProvider(
  entry: Record<string, unknown>,
  path: string,
  checker: Checker,
): ProviderSpec {
  const baseUrl = checker.string(entry, 'baseUrl', `${path}.baseUrl`, {
    required: true,
    pattern: /^https?:\/\//,
  });
  const api = checker.string(entry, 'api', `${path}.api`, {
    required: true,
    values: SUPPORTED_APIS,
  });
  const apiKey = checker.string(entry, 'apiKey', `${path}.apiKey`);
  const headers = checker.stringMap(entry, 'headers', `${path}.headers`);

  const models: ModelSpec[] = [];
  const modelsValue = entry['models'];
  if (modelsValue === undefined || modelsValue === null) {
    checker.fail(`${path}.models`, '缺少必填字段(至少声明一个模型)');
  } else if (!Array.isArray(modelsValue)) {
    checker.fail(`${path}.models`, '应为数组');
  } else if (modelsValue.length === 0) {
    checker.fail(`${path}.models`, '至少声明一个模型');
  } else {
    modelsValue.forEach((item, index) => {
      const itemPath = `${path}.models[${index}]`;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        checker.fail(itemPath, '应为对象');
        return;
      }
      models.push(parseModel(item as Record<string, unknown>, itemPath, checker));
    });
    // 同一 provider 内 id 必须唯一:resolveModel 用 find 取第一条,重复会让后者静默失效
    const seen = new Set<string>();
    models.forEach((model, index) => {
      if (model.id === '') {
        return; // 空 id 已由必填校验报错
      }
      if (seen.has(model.id)) {
        checker.fail(`${path}.models[${index}].id`, `模型 id 重复:"${model.id}"`);
      }
      seen.add(model.id);
    });
  }

  return {
    baseUrl: baseUrl ?? '',
    api: api ?? '',
    apiKey,
    headers,
    models,
  };
}

function parseModel(entry: Record<string, unknown>, path: string, checker: Checker): ModelSpec {
  const id = checker.string(entry, 'id', `${path}.id`, { required: true });
  const name = checker.string(entry, 'name', `${path}.name`);
  const contextWindow = checker.number(entry, 'contextWindow', `${path}.contextWindow`, {
    integer: true,
    min: 1,
  });
  const maxTokens = checker.number(entry, 'maxTokens', `${path}.maxTokens`, {
    integer: true,
    min: 1,
  });
  const reasoning = checker.boolean(entry, 'reasoning', `${path}.reasoning`);
  const headers = checker.stringMap(entry, 'headers', `${path}.headers`);

  let input: ('text' | 'image')[] | undefined;
  const rawInput = checker.stringArray(entry, 'input', `${path}.input`);
  if (rawInput) {
    input = [];
    for (const item of rawInput) {
      if (item !== 'text' && item !== 'image') {
        checker.fail(`${path}.input`, `取值必须是 text | image 之一,实际为 "${item}"`);
        continue;
      }
      input.push(item);
    }
  }

  let cost: ModelCost | undefined;
  const costTable = checker.object(entry, 'cost', `${path}.cost`);
  if (costTable) {
    const inputPrice = checker.number(costTable, 'input', `${path}.cost.input`, {
      required: true,
      min: 0,
    });
    const outputPrice = checker.number(costTable, 'output', `${path}.cost.output`, {
      required: true,
      min: 0,
    });
    const cacheRead = checker.number(costTable, 'cacheRead', `${path}.cost.cacheRead`, { min: 0 });
    const cacheWrite = checker.number(costTable, 'cacheWrite', `${path}.cost.cacheWrite`, {
      min: 0,
    });
    if (inputPrice !== undefined && outputPrice !== undefined) {
      cost = { input: inputPrice, output: outputPrice, cacheRead, cacheWrite };
    }
  }

  return {
    id: id ?? '',
    name,
    contextWindow,
    maxTokens,
    reasoning,
    input,
    cost,
    headers,
  };
}
