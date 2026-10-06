import { ReinsError } from '../util/errors.ts';

/**
 * 出站代理解析。
 *
 * 语义:未配置或显式空串 = 直连(空串用于强制忽略环境中的代理变量);
 * 非空 = 使用代理。代理能力由运行时的 undici 提供,缺失时给出可行动的报错。
 */
export async function resolveProxyDispatcher(
  proxy: string | undefined,
): Promise<unknown | undefined> {
  if (proxy === undefined || proxy === '') {
    return undefined;
  }
  const specifier = 'undici';
  try {
    const undici = (await import(specifier)) as { ProxyAgent: new (url: string) => unknown };
    return new undici.ProxyAgent(proxy);
  } catch {
    throw new ReinsError(
      'proxy',
      `已配置出站代理 ${proxy},但运行环境缺少 undici 依赖`,
      '安装 undici 后重试,或将 config.toml 的 proxy 置为空串以直连。',
    );
  }
}
