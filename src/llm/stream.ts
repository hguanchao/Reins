import { ReinsError } from '../util/errors.ts';
import { AnthropicMessagesAdapter } from './adapters/anthropic-messages.ts';
import { GoogleGenerativeAiAdapter } from './adapters/google-generative-ai.ts';
import { OpenAiCompletionsAdapter } from './adapters/openai-completions.ts';
import { OpenAiResponsesAdapter } from './adapters/openai-responses.ts';
import type { ProviderAdapter } from './types.ts';

/**
 * 适配器注册表:按 providers.json 声明的 api 选择协议实现。
 *
 * 设计意图:这里只有协议、没有产商;新增协议只在本表登记一行。
 */

const ADAPTER_FACTORIES: ReadonlyMap<string, () => ProviderAdapter> = new Map<
  string,
  () => ProviderAdapter
>([
  ['openai-completions', () => new OpenAiCompletionsAdapter()],
  ['openai-responses', () => new OpenAiResponsesAdapter()],
  ['anthropic-messages', () => new AnthropicMessagesAdapter()],
  ['google-generative-ai', () => new GoogleGenerativeAiAdapter()],
]);

export function createAdapter(api: string): ProviderAdapter {
  const factory = ADAPTER_FACTORIES.get(api);
  if (factory === undefined) {
    throw new ReinsError(
      'llm',
      `providers.json 声明了暂不支持的协议:${api}`,
      `当前已实现的协议:${supportedApis().join('、')}`,
    );
  }
  return factory();
}

export function supportedApis(): string[] {
  return [...ADAPTER_FACTORIES.keys()];
}
