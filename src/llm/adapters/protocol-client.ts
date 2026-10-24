import type { ModelEntry, ProviderEntry } from "../../config/providers-file.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../client.ts";
import type { RetryPolicy } from "../retry.ts";
import { ContentAccumulator } from "./content-accumulator.ts";
import { createLlmStream } from "./stream-runner.ts";

/**
 * 三家协议适配器的公共骨架。
 *
 * 构造参数、流式包装与「先收集全部内容块、结束时整体交付」的顺序只写这一份:三个子类
 * 各写一遍后,改包装方式要同步改三处。子类只实现 #run(具体的协议对话)并声明 api 名。
 */
export abstract class ProtocolClient implements LlmClient {
	abstract readonly api: string;

	readonly #provider: ProviderEntry;
	readonly #model: ModelEntry;
	readonly #policy: RetryPolicy;
	readonly #proxy: string | undefined;
	/** 流式读取的静默上限（毫秒）；undefined 表示不限 */
	readonly #idleTimeoutMs: number | undefined;

	constructor(
		provider: ProviderEntry,
		model: ModelEntry,
		policy: RetryPolicy,
		proxy?: string,
		idleTimeoutMs?: number,
	) {
		this.#provider = provider;
		this.#model = model;
		this.#policy = policy;
		this.#proxy = proxy;
		this.#idleTimeoutMs = idleTimeoutMs;
	}

	stream(request: LlmRequest): LlmStream {
		const accumulator = new ContentAccumulator();
		return createLlmStream(
			request,
			(emit) => this.runProtocol(request, emit, accumulator),
			() => {
				accumulator.finishAll();
				return accumulator.blocks();
			},
		);
	}

	protected get provider(): ProviderEntry {
		return this.#provider;
	}

	protected get model(): ModelEntry {
		return this.#model;
	}

	protected get policy(): RetryPolicy {
		return this.#policy;
	}

	protected get proxy(): string | undefined {
		return this.#proxy;
	}

	protected get idleTimeoutMs(): number | undefined {
		return this.#idleTimeoutMs;
	}

	protected abstract runProtocol(
		request: LlmRequest,
		emit: (event: LlmEvent) => void,
		accumulator: ContentAccumulator,
	): Promise<LlmResult>;
}
