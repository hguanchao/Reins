import type { ModelEntry, ProviderEntry } from "../config/providers-file.ts";
import { AnthropicMessagesClient } from "./adapters/anthropic-messages.ts";
import { OpenAiCompletionsClient } from "./adapters/openai-completions.ts";
import type { LlmClient } from "./client.ts";
import type { RetryPolicy } from "./retry.ts";

/**
 * 线上协议适配器的注册表。
 *
 * 适配器属于宿主而非插件：模型层是唯一持有密钥、也是唯一发出站请求的地方，内置之后插件在
 * 结构上就没办法拦截或外传对话内容。代价是新增一种协议要改宿主代码，这是这个选择买下的东西。
 */

export interface LlmClientFactory {
	readonly api: string;
	create(provider: ProviderEntry, model: ModelEntry, policy: RetryPolicy): LlmClient;
}

export class LlmRegistry {
	readonly #factories: LlmClientFactory[] = [];

	register(factory: LlmClientFactory): void {
		if (this.#factories.some((item) => item.api === factory.api)) {
			throw new Error(`协议 ${factory.api} 已经有适配器`);
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
	create(provider: ProviderEntry, model: ModelEntry, policy: RetryPolicy): LlmClient {
		const factory = this.#factories.find((item) => item.api === model.api);
		if (factory === undefined) {
			throw new Error(`没有 ${model.api} 协议的适配器，可用：${this.apis().join("、")}`);
		}
		return factory.create(provider, model, policy);
	}
}

/** 随包分发的两个适配器。 */
export function createBuiltinLlmRegistry(): LlmRegistry {
	const registry = new LlmRegistry();
	registry.register({
		api: "anthropic-messages",
		create: (provider, model, policy) => new AnthropicMessagesClient(provider, model, policy),
	});
	registry.register({
		api: "openai-completions",
		create: (provider, model, policy) => new OpenAiCompletionsClient(provider, model, policy),
	});
	return registry;
}
