import type { ModelEntry, ProviderEntry } from "#src/config/providers-file.ts";
import { AnthropicMessagesClient } from "#src/llm/adapters/anthropic-messages.ts";
import { OpenAiCompletionsClient } from "#src/llm/adapters/openai-completions.ts";
import { OpenAiResponsesClient } from "#src/llm/adapters/openai-responses.ts";
import type { LlmClient } from "#src/llm/client.ts";
import type { RetryPolicy } from "#src/llm/retry.ts";

/**
 * 线上协议适配器的注册表。
 *
 * 适配器属于宿主而非插件：模型层是唯一持有密钥、也是唯一发出站请求的地方，内置之后插件在
 * 结构上就没办法拦截或外传对话内容。代价是新增一种协议要改宿主代码，这是这个选择买下的东西。
 */

export interface LlmClientFactory {
	readonly api: string;
	create(
		provider: ProviderEntry,
		model: ModelEntry,
		policy: RetryPolicy,
		proxy?: string,
		idleTimeoutMs?: number,
	): LlmClient;
}

export class LlmRegistry {
	readonly #factories: LlmClientFactory[] = [];

	register(factory: LlmClientFactory): void {
		if (this.#factories.some((item) => item.api === factory.api)) {
			throw new Error(`protocol ${factory.api} already has an adapter`);
		}
		this.#factories.push(factory);
	}

	apis(): readonly string[] {
		return this.#factories.map((item) => item.api);
	}

	/**
	 * 按模型声明的协议建客户端。
	 *
	 * 协议名不认识时直接报错并列出可用项：静默挑一个顶上会让使用者以为接通了，其实请求
	 * 发去了别的地方。
	 */
	create(
		provider: ProviderEntry,
		model: ModelEntry,
		policy: RetryPolicy,
		proxy?: string,
		idleTimeoutMs?: number,
	): LlmClient {
		const factory = this.#factories.find((item) => item.api === model.api);
		if (factory === undefined) {
			throw new Error(`no adapter for protocol ${model.api}; available protocols: ${this.apis().join(", ")}`);
		}
		return factory.create(provider, model, policy, proxy, idleTimeoutMs);
	}
}

/** 随包分发的三个适配器。 */
export function createBuiltinLlmRegistry(): LlmRegistry {
	const registry = new LlmRegistry();
	registry.register({
		api: "anthropic-messages",
		create: (provider, model, policy, proxy, idleTimeoutMs) =>
			new AnthropicMessagesClient(provider, model, policy, proxy, idleTimeoutMs),
	});
	registry.register({
		api: "openai-completions",
		create: (provider, model, policy, proxy, idleTimeoutMs) =>
			new OpenAiCompletionsClient(provider, model, policy, proxy, idleTimeoutMs),
	});
	registry.register({
		api: "openai-responses",
		create: (provider, model, policy, proxy, idleTimeoutMs) =>
			new OpenAiResponsesClient(provider, model, policy, proxy, idleTimeoutMs),
	});
	return registry;
}
