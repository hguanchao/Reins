import type { Config } from "./file.ts";
import type { ModelEntry, ProviderEntry, ProvidersConfig } from "./providers-file.ts";
import type { ModelSelection } from "./selection.ts";

/**
 * 会话内的模型目录。
 *
 * 列表和切换规则属于宿主：TUI 只负责显示与上报选择，不解析 providers.json，也不自己判断
 * 辅助模型是否可用。切换只改这份目录里的当前选型，不写配置文件。
 */

interface ModelOption {
	readonly provider: string;
	readonly model: string;
	readonly name: string;
	/** 是否是当前正在使用的模型 */
	readonly current: boolean;
}

interface ModelSwitchOutcome {
	readonly selection: ModelSelection;
	/** 目标 provider 缺少 compact_model / review_model 时的说明 */
	readonly warnings: readonly string[];
}

export class ModelCatalog {
	readonly #providers: ProvidersConfig;
	readonly #config: Config;
	#current: ModelSelection | undefined;

	constructor(
		providers: ProvidersConfig,
		config: Config,
		current: ModelSelection | undefined,
	) {
		this.#providers = providers;
		this.#config = config;
		this.#current = current;
	}

	/** 当前选型；配置里的 provider/model 对不上时为 undefined。 */
	get selection(): ModelSelection | undefined {
		return this.#current;
	}

	/** 按 providers.json 的声明顺序列出全部模型；没有当前选型时不标记 current。 */
	options(): readonly ModelOption[] {
		const options: ModelOption[] = [];
		for (const provider of this.#providers.providers) {
			for (const model of provider.models) {
				options.push({
					provider: provider.id,
					model: model.id,
					name: model.name,
					current:
						this.#current !== undefined &&
						provider.id === this.#current.provider.id &&
						model.id === this.#current.model.id,
				});
			}
		}
		return options;
	}

	/**
	 * 切换到指定模型。
	 *
	 * 辅助模型只在目标 provider 内查找：配置里的 compact_model 与 review_model 属于原
	 * provider 时，换过去不能继续沿用，否则请求会发到一个不存在的模型上。缺失时回退到主
	 * 模型，并把原因交给界面显示，不静默处理。
	 */
	switchTo(providerId: string, modelId: string): ModelSwitchOutcome {
		const provider = this.#providers.providers.find((item) => item.id === providerId);
		if (provider === undefined) throw new Error(`No provider ${providerId}`);
		const model = provider.models.find((item) => item.id === modelId);
		if (model === undefined) throw new Error(`No model ${modelId} under provider ${providerId}`);

		const warnings: string[] = [];
		const compactModel = resolveAuxiliary(
			provider,
			this.#config.compactModel,
			"compact_model",
			warnings,
		);
		const reviewModel = resolveAuxiliary(
			provider,
			this.#config.reviewModel,
			"review_model",
			warnings,
		);

		this.#current = { provider, model, compactModel, reviewModel };
		return { selection: this.#current, warnings };
	}
}

function resolveAuxiliary(
	provider: ProviderEntry,
	id: string | undefined,
	key: string,
	warnings: string[],
): ModelEntry | undefined {
	if (id === undefined) return undefined;

	const model = provider.models.find((item) => item.id === id);
	if (model !== undefined) return model;

	warnings.push(`${key} "${id}" is not available in provider ${provider.id}; using the main model.`);
	return undefined;
}
