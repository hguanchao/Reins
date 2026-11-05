import {
	parseProviders,
	type ModelEntry,
	type ProviderEntry,
	type ProvidersConfig,
} from "#src/config/providers-file.ts";

/**
 * 设置页的提供方视图与写回。
 *
 * GET 不回传 API Key，只告诉界面「是否已经保存过」；保存时留空表示保持原值。写回前用
 * parseProviders 再校验一遍，避免界面拼出的对象把 providers.json 写成宿主读不懂的形状。
 */

export interface ProviderView {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string | undefined;
	readonly api: string | undefined;
	readonly hasApiKey: boolean;
	readonly headers: Readonly<Record<string, string>>;
	readonly promptCacheKey: boolean;
	readonly models: readonly ModelEntry[];
}

export function providerViews(config: ProvidersConfig): readonly ProviderView[] {
	return config.providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl,
		api: provider.api,
		hasApiKey: provider.apiKey !== undefined && provider.apiKey.length > 0,
		headers: provider.headers,
		promptCacheKey: provider.promptCacheKey,
		models: provider.models,
	}));
}

export interface ProviderWriteResult {
	readonly ok: boolean;
	readonly config?: ProvidersConfig;
	readonly error?: string;
}

/** 新增或更新一个提供方；留空的 API Key 保持原值。 */
export function mergeProvider(
	current: ProvidersConfig,
	input: Record<string, unknown>,
	file: string,
): ProviderWriteResult {
	const rawId = input["id"];
	if (typeof rawId !== "string" || rawId.trim().length === 0) {
		return { ok: false, error: "请填写提供方 ID" };
	}
	const id = rawId.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
		return { ok: false, error: "提供方 ID 只能使用字母、数字、点、- 和 _" };
	}
	if (id === "__proto__" || id === "constructor" || id === "prototype") {
		return { ok: false, error: "这个提供方 ID 不可用" };
	}

	const existing = current.providers.find((provider) => provider.id === id);
	const next: Record<string, unknown> = {
		...(existing === undefined ? {} : providerObject(existing)),
		...input,
	};
	delete next["id"];
	delete next["hasApiKey"];

	const apiKey = next["apiKey"];
	if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
		if (existing?.apiKey === undefined) delete next["apiKey"];
		else next["apiKey"] = existing.apiKey;
	} else {
		next["apiKey"] = apiKey.trim();
	}

	const providers: Record<string, unknown> = {};
	for (const provider of current.providers) {
		if (provider.id !== id) providers[provider.id] = providerObject(provider);
	}
	providers[id] = next;
	return validate(providers, file);
}

/** 删除一个提供方；至少保留一个，当前正在使用的那一个由调用方拦下。 */
export function removeProvider(
	current: ProvidersConfig,
	id: string,
	file: string,
): ProviderWriteResult {
	if (!current.providers.some((provider) => provider.id === id)) {
		return { ok: false, error: `提供方 ${id} 不存在` };
	}
	if (current.providers.length <= 1) {
		return { ok: false, error: "至少需要保留一个提供方" };
	}
	const providers: Record<string, unknown> = {};
	for (const provider of current.providers) {
		if (provider.id !== id) providers[provider.id] = providerObject(provider);
	}
	return validate(providers, file);
}

function providerObject(provider: ProviderEntry): Record<string, unknown> {
	return {
		name: provider.name,
		baseUrl: provider.baseUrl,
		api: provider.api,
		apiKey: provider.apiKey,
		headers: provider.headers,
		promptCacheKey: provider.promptCacheKey,
		models: provider.models,
	};
}

function validate(providers: Record<string, unknown>, file: string): ProviderWriteResult {
	try {
		const source = JSON.stringify({ providers }, null, 2);
		return { ok: true, config: parseProviders(source, file) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
