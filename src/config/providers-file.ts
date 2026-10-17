import { ConfigError } from "./config-error.ts";
import {
	readTextFile,
	THINKING_LEVELS,
	wrapParseErrors,
	type ThinkingLevel,
} from "./config-file.ts";
import { JsonDocument } from "./json/index.ts";
import { providersFilePath } from "./paths.ts";
import {
	assertNoUnknownKeys,
	describePath,
	readBoolean,
	readEnumArray,
	readInteger,
	readNumber,
	readString,
	readStringMap,
	readTable,
	type ConfigSource,
} from "./reader.ts";
import { isConfigTable, type ConfigPath } from "./value.ts";
import type { LlmUsage } from "../llm/messages.ts";

/**
 * 端点与模型的声明。
 *
 * 这里没有任何内置的 provider 或模型：能连什么端点、端点上有哪些模型、各自的能力与上限，
 * 全部由使用者声明，程序只负责校验与解析。
 */

/** 等级到 provider 原生取值的映射。null 表示该等级不支持，省略表示交给 provider 默认。 */
export type ThinkingLevelMap = Readonly<Partial<Record<ThinkingLevel, string | null>>>;

/** 模型能接收的输入形态。 */
export type ModelModality = "text" | "image";

export const MODEL_MODALITIES: readonly ModelModality[] = ["text", "image"];

/**
 * 单价，美元每百万 token。
 *
 * 四项都必填：只写一半的单价表算出来的金额是错的，而错金额比没有金额更容易骗人。不知道
 * 缓存价就照实际计费写，别拿 0 填——0 的含义是「这一项不收费」。
 */
export interface ModelCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

const COST_KEYS: readonly string[] = ["input", "output", "cacheRead", "cacheWrite"];

/**
 * 按单价算一次请求的金额。
 *
 * 没配单价时返回 undefined 而不是 0：0 会被读成「这次不要钱」，而事实是「不知道」。
 */
export function computeCost(cost: ModelCost | undefined, usage: LlmUsage): number | undefined {
	if (cost === undefined) return undefined;
	const perMillion =
		usage.input * cost.input +
		usage.output * cost.output +
		usage.cacheRead * cost.cacheRead +
		usage.cacheWrite * cost.cacheWrite;
	return perMillion / 1_000_000;
}

export interface ModelEntry {
	readonly id: string;
	readonly name: string;
	/** 线上协议名，取值由内置适配器决定 */
	readonly api: string;
	readonly baseUrl: string;
	/** 是否支持思考等级控制 */
	readonly reasoning: boolean;
	readonly thinkingLevelMap: ThinkingLevelMap;
	/** 能接收的输入形态。省略时按只收文本算——没声明就不替它猜 */
	readonly input: readonly ModelModality[];
	/** 单价。省略时只报 token，不报金额 */
	readonly cost: ModelCost | undefined;
	/** 未声明时为 undefined，不代填默认值 */
	readonly contextWindow: number | undefined;
	readonly maxTokens: number | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

export interface ProviderEntry {
	readonly id: string;
	readonly name: string;
	/** provider 级默认；模型自己声明时会覆盖，因此两者都为 undefined 时该模型直接报错 */
	readonly baseUrl: string | undefined;
	readonly api: string | undefined;
	/** 字面值、$NAME 环境插值、或以 ! 开头的命令；解析在发出请求前进行 */
	readonly apiKey: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
	readonly models: readonly ModelEntry[];
}

export interface ProvidersConfig {
	readonly providers: readonly ProviderEntry[];
}

const TOP_LEVEL_KEYS: readonly string[] = ["providers"];
const PROVIDER_KEYS: readonly string[] = ["name", "baseUrl", "api", "apiKey", "headers", "models"];
const MODEL_KEYS: readonly string[] = [
	"id",
	"name",
	"api",
	"baseUrl",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
	"headers",
];

/** 解析并校验 providers.json 的内容。纯函数，便于单测直接喂字符串。 */
export function parseProviders(source: string, file: string): ProvidersConfig {
	// 解析与校验两阶段的错误都要带上文件路径：缺了它使用者只能看到「第 3 行」，不知道是哪个文件
	return wrapParseErrors(file, () => {
		const document = new JsonDocument(source);

		assertNoUnknownKeys(document, [], TOP_LEVEL_KEYS);

		const providerTable = readTable(document, ["providers"]);
		if (providerTable === undefined) throw new ConfigError("Missing providers");
		const providerIds = Object.keys(providerTable);
		if (providerIds.length === 0) throw new ConfigError("providers must declare at least one provider");

		return { providers: providerIds.map((id) => readProvider(document, id)) };
	});
}

export function loadProviders(file: string = providersFilePath()): ProvidersConfig {
	return parseProviders(readTextFile(file), file);
}

function readProvider(source: ConfigSource, id: string): ProviderEntry {
	const path: ConfigPath = ["providers", id];
	assertNoUnknownKeys(source, path, PROVIDER_KEYS);

	const baseUrl = readString(source, [...path, "baseUrl"]);
	const api = readString(source, [...path, "api"]);

	const models = readModelList(source, id, path, { baseUrl, api });
	return {
		id,
		name: readString(source, [...path, "name"]) ?? id,
		baseUrl,
		api,
		apiKey: readString(source, [...path, "apiKey"]),
		headers: readStringMap(source, [...path, "headers"]) ?? {},
		models,
	};
}

function readModelList(
	source: ConfigSource,
	providerId: string,
	providerPath: ConfigPath,
	providerDefaults: { baseUrl: string | undefined; api: string | undefined },
): readonly ModelEntry[] {
	const value = source.get([...providerPath, "models"]);
	if (value === undefined) {
		throw new ConfigError(`${describePath(providerPath)} is missing models`, {
			...(source.locationOf(providerPath) ?? {}),
		});
	}
	if (!Array.isArray(value)) {
		throw new ConfigError(`${describePath([...providerPath, "models"])} must be an array`, {
			...(source.locationOf([...providerPath, "models"]) ?? {}),
		});
	}
	if (value.length === 0) {
		// 没有模型的 provider 无法被选中，属于配置疏漏而不是合法状态
		throw new ConfigError(
			`${describePath(providerPath)} must declare at least one model`,
			source.locationOf(providerPath) ?? {},
		);
	}

	const seen = new Set<string>();
	const models: ModelEntry[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const path: ConfigPath = [...providerPath, "models", index];
		assertNoUnknownKeys(source, path, MODEL_KEYS);

		const id = readString(source, [...path, "id"]);
		if (id === undefined) {
			throw new ConfigError(`${describePath(path)} is missing id`, source.locationOf(path) ?? {});
		}
		if (seen.has(id)) {
			// 同一个 provider 下同名模型会互相遮蔽，只留一个不如直接报错
			throw new ConfigError(`Duplicate model ${id} under ${providerId}`, source.locationOf([...path, "id"]) ?? {});
		}
		seen.add(id);

		const api = readString(source, [...path, "api"]) ?? providerDefaults.api;
		if (api === undefined) {
			throw new ConfigError(
				`Model ${providerId}/${id} has no usable api: neither the provider nor the model declares one`,
				source.locationOf(path) ?? {},
			);
		}
		const baseUrl = readString(source, [...path, "baseUrl"]) ?? providerDefaults.baseUrl;
		if (baseUrl === undefined) {
			throw new ConfigError(
				`Model ${providerId}/${id} has no usable baseUrl: neither the provider nor the model declares one`,
				source.locationOf(path) ?? {},
			);
		}

		models.push({
			id,
			name: readString(source, [...path, "name"]) ?? id,
			api,
			baseUrl,
			reasoning: readBoolean(source, [...path, "reasoning"]) ?? false,
			thinkingLevelMap: readThinkingLevelMap(source, [...path, "thinkingLevelMap"]),
			input: readModalities(source, [...path, "input"]),
			cost: readCost(source, [...path, "cost"]),
			contextWindow: readInteger(source, [...path, "contextWindow"], 1),
			maxTokens: readInteger(source, [...path, "maxTokens"], 1),
			headers: readStringMap(source, [...path, "headers"]) ?? {},
		});
	}
	return models;
}

function readThinkingLevelMap(source: ConfigSource, path: ConfigPath): ThinkingLevelMap {
	const value = source.get(path);
	if (value === undefined) return {};
	if (!isConfigTable(value)) {
		throw new ConfigError(`${describePath(path)} must be a table`, source.locationOf(path) ?? {});
	}

	const result: Partial<Record<ThinkingLevel, string | null>> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!THINKING_LEVELS.some((level) => level === key)) {
			throw new ConfigError(
				`${describePath([...path, key])} must be one of ${THINKING_LEVELS.join(", ")}`,
				source.locationOf([...path, key]) ?? {},
			);
		}
		if (item !== null && typeof item !== "string") {
			throw new ConfigError(
				`${describePath([...path, key])} must be a string or null`,
				source.locationOf([...path, key]) ?? {},
			);
		}
		result[key as ThinkingLevel] = item;
	}
	return result;
}

/**
 * 能接收的输入形态。
 *
 * 省略时按只收文本算：没有声明就说明写配置的人没想过这件事，替它加上图片只会让请求在
 * 端点那里失败。
 */
function readModalities(source: ConfigSource, path: ConfigPath): readonly ModelModality[] {
	const declared = readEnumArray(source, path, MODEL_MODALITIES);
	if (declared === undefined) return ["text"];
	if (declared.length === 0) {
		throw new ConfigError(`${describePath(path)} must declare at least one input modality`, source.locationOf(path) ?? {});
	}
	// 重复声明说明写的人不清楚自己要什么，报错比默默去重好
	const unique = [...new Set(declared)];
	if (unique.length !== declared.length) {
		throw new ConfigError(`${describePath(path)} has duplicate values`, source.locationOf(path) ?? {});
	}
	return unique;
}

function readCost(source: ConfigSource, path: ConfigPath): ModelCost | undefined {
	const table = readTable(source, path);
	if (table === undefined) return undefined;

	assertNoUnknownKeys(source, path, COST_KEYS);
	const missing = COST_KEYS.filter((key) => table[key] === undefined);
	if (missing.length > 0) {
		throw new ConfigError(
			`${describePath(path)} is missing ${missing.join(", ")}: a half-written price list produces wrong costs`,
			source.locationOf(path) ?? {},
		);
	}

	return {
		input: readNumber(source, [...path, "input"], 0) ?? 0,
		output: readNumber(source, [...path, "output"], 0) ?? 0,
		cacheRead: readNumber(source, [...path, "cacheRead"], 0) ?? 0,
		cacheWrite: readNumber(source, [...path, "cacheWrite"], 0) ?? 0,
	};
}
