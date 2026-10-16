import { ConfigError } from "./config-error.ts";
import type { Config } from "./config-file.ts";
import type { ModelEntry, ModelsConfig, ProviderEntry } from "./models-file.ts";

/**
 * 把 config.toml 选的 provider 与模型对应到 models.json 里的具体条目。
 *
 * 这是两份配置之间唯一的交叉约束：config.toml 负责「用哪一个」，models.json 负责
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
	models: ModelsConfig,
	configFile: string,
	modelsFile: string,
): ModelSelection {
	const provider = models.providers.find((item) => item.id === config.provider);
	if (provider === undefined) {
		throw new ConfigError(
			`models.json 里没有 provider ${config.provider}，可选项：${listProviders(models)}`,
			{ file: modelsFile },
		);
	}

	const model = provider.models.find((item) => item.id === config.model);
	if (model === undefined) {
		throw new ConfigError(
			`provider ${config.provider} 下没有模型 ${config.model}，可选项：${listModels(provider)}。` +
				`provider 与模型分别写在 ${configFile} 与 ${modelsFile} 里`,
			{ file: modelsFile },
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
			`${key} 指定的模型 ${id} 不在 provider ${provider.id} 内，可选项：${listModels(provider)}`,
			{ file: configFile },
		);
	}
	return model;
}

function listProviders(models: ModelsConfig): string {
	return models.providers.map((item) => item.id).join("、");
}

function listModels(provider: ProviderEntry): string {
	return provider.models.map((item) => item.id).join("、");
}
