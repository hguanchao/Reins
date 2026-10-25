import { ConfigError } from "./error.ts";
import type { Config } from "./file.ts";
import type { ModelEntry, ProvidersConfig, ProviderEntry } from "./providers-file.ts";

/**
 * 把 config.toml 选的 provider 与模型对应到 providers.json 里的具体条目。
 *
 * 这是两份配置之间唯一的交叉约束：config.toml 负责「用哪一个」，providers.json 负责
 * 「那一个长什么样」。写错名字时把可选项列出来，省去使用者来回对照两份文件。
 */
export interface ModelSelection {
	readonly provider: ProviderEntry;
	readonly model: ModelEntry;
	/** 压缩摘要专用模型，必须落在同一个 provider 内 */
	readonly compactModel: ModelEntry | undefined;
	/** 审批审查专用模型，必须落在同一个 provider 内 */
	readonly reviewModel: ModelEntry | undefined;
}

export function resolveSelection(
	config: Config,
	providersConfig: ProvidersConfig,
	configFile: string,
	providersFile: string,
): ModelSelection {
	const provider = providersConfig.providers.find((item) => item.id === config.provider);
	if (provider === undefined) {
		throw new ConfigError(
			`No provider ${config.provider} in providers.json; available: ${listProviders(providersConfig)}`,
			{ file: providersFile },
		);
	}

	const model = provider.models.find((item) => item.id === config.model);
	if (model === undefined) {
		throw new ConfigError(
			`No model ${config.model} under provider ${config.provider}; available: ${listModels(provider)}. ` +
				`The provider and the model are set in ${configFile} and ${providersFile} respectively`,
			{ file: providersFile },
		);
	}

	return {
		provider,
		model,
		compactModel: resolveWithinProvider(provider, config.compactModel, configFile, "compact_model"),
		reviewModel: resolveWithinProvider(provider, config.reviewModel, configFile, "review_model"),
	};
}

function resolveWithinProvider(
	provider: ProviderEntry,
	id: string | undefined,
	configFile: string,
	key: string,
): ModelEntry | undefined {
	if (id === undefined) return undefined;

	const model = provider.models.find((item) => item.id === id);
	if (model === undefined) {
		throw new ConfigError(
			`Model ${id} set by ${key} is not in provider ${provider.id}; available: ${listModels(provider)}`,
			{ file: configFile },
		);
	}
	return model;
}

function listProviders(providersConfig: ProvidersConfig): string {
	return providersConfig.providers.map((item) => item.id).join(", ");
}

function listModels(provider: ProviderEntry): string {
	return provider.models.map((item) => item.id).join(", ");
}
