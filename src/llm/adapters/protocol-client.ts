import type { ModelEntry, ProviderEntry } from "../../config/providers-file.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../client.ts";
import { postSse } from "../http.ts";
import type { RetryPolicy } from "../retry.ts";
import { ContentAccumulator } from "./content-accumulator.ts";
import { createLlmStream, joinUrl } from "./stream-runner.ts";

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

	/**
	 * 发一次流式 POST。
	 *
	 * 三个子类只有路径、鉴权头与结束判据不同，其余（地址拼接、通用头、重试策略、静默上限）
	 * 全在这里。密钥头由调用方现取后传入，因为 command 形式的密钥可能短期有效。
	 */
	protected async postStream(
		request: LlmRequest,
		path: string,
		authHeaders: Readonly<Record<string, string>>,
		complete: () => boolean,
		onData: (data: string) => void,
	): Promise<void> {
		await postSse(
			{
				url: joinUrl(this.model.baseUrl, path),
				headers: { ...this.provider.headers, ...this.model.headers, ...authHeaders },
				body: this.buildBody(request),
				signal: request.signal,
				onRetry: request.onRetry,
				proxy: this.proxy,
				complete,
			},
			onData,
			this.policy,
			this.idleTimeoutMs,
		);
	}

	/** 按协议拼请求体；各子类的协议字段不同。 */
	protected abstract buildBody(request: LlmRequest): Record<string, unknown>;

	protected abstract runProtocol(
		request: LlmRequest,
		emit: (event: LlmEvent) => void,
		accumulator: ContentAccumulator,
	): Promise<LlmResult>;
}
