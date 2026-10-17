import { readFileSync } from "node:fs";

import { ConfigError } from "./config-error.ts";
import { configFilePath } from "./paths.ts";
import {
	assertNoUnknownKeys,
	readBoolean,
	readEnum,
	readInteger,
	readString,
	readStringArray,
	readStringMap,
	readTable,
} from "./reader.ts";
import { TomlDocument } from "./toml/index.ts";

/**
 * 配置文件的词汇表。
 *
 * 允许的取值集中定义在这里：读取时按它校验，消费方按它分支。放在配置层是因为这些词
 * 属于「界面」——使用者能写什么、程序认什么——而各自的语义由消费模块实现。
 */

/** 思考等级。off 表示不向模型发送任何思考参数。 */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

/** 审批方式：ask 逐次询问，auto 交给审查模型，yolo 不询问。 */
export type ApprovalMode = "ask" | "auto" | "yolo";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto", "yolo"];

/** 沙箱模式：off 不隔离，workspace 只允许写工作区，read-only 不允许写。 */
export type SandboxMode = "off" | "workspace" | "read-only";

export const SANDBOX_MODES: readonly SandboxMode[] = ["off", "workspace", "read-only"];

export type NotifyMode = "auto" | "bell" | "desktop" | "off";

export const NOTIFY_MODES: readonly NotifyMode[] = ["auto", "bell", "desktop", "off"];

/** MCP server 的接入形态：stdio 起本地进程，http 与 sse 连远程端点。 */
export type McpServerType = "stdio" | "http" | "sse";

export interface McpServerConfig {
	readonly name: string;
	readonly type: McpServerType;
	/** 仅 stdio 使用 */
	readonly command: string | undefined;
	readonly args: readonly string[];
	/** 仅 http 与 sse 使用 */
	readonly url: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
	/** 只作用于工具调用；连接与控制请求用的是固定的短超时 */
	readonly callTimeoutMs: number | undefined;
	readonly disabled: boolean;
}

export interface PluginsConfig {
	readonly disabled: readonly string[];
	/** 已信任的工作区根，由 --trust 与信任页回写 */
	readonly trusted: readonly string[];
}

export interface UiConfig {
	readonly notify: NotifyMode;
}

export interface Config {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort: ThinkingLevel;
	/** providers.json 里模型没声明时可以在这里兜底；两处都没有则无法计算压缩阈值 */
	readonly contextWindow: number | undefined;
	readonly maxTokens: number | undefined;
	readonly maxRetries: number;
	/** 显式空串表示强制直连 */
	readonly httpProxy: string | undefined;
	/** 压缩摘要专用模型，取值是所选 provider 内的模型 id */
	readonly compactModel: string | undefined;
	/** auto 审批的审查模型，取值是所选 provider 内的模型 id */
	readonly reviewModel: string | undefined;
	readonly approval: ApprovalMode;
	readonly sandbox: SandboxMode;
	/** 子代理的模型调用上限；省略时由子代理自己决定默认步数 */
	readonly maxTurns: number | undefined;
	/** 工具结果超过这个字符数就落盘，上下文只留预览；0 表示关闭 */
	readonly spillThreshold: number;
	readonly ui: UiConfig;
	readonly mcpServers: readonly McpServerConfig[];
	readonly plugins: PluginsConfig;
}

/**
 * 省略各项时的取值。
 *
 * 只有与具体模型无关的项才给默认值：上下文窗口、输出上限、思考等级一律留空，让模型自己
 * 或上层适配器决定，不替使用者凭空选一个数字。重试次数与落盘阈值属于客户端行为，
 * 给具体值不会让人意外。
 */
const DEFAULT_REASONING_EFFORT: ThinkingLevel = "off";
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_APPROVAL: ApprovalMode = "ask";
const DEFAULT_SANDBOX: SandboxMode = "off";
const DEFAULT_SPILL_THRESHOLD = 8192;
const DEFAULT_NOTIFY: NotifyMode = "auto";

const TOP_LEVEL_KEYS: readonly string[] = [
	"provider",
	"model",
	"reasoning_effort",
	"context_window",
	"max_tokens",
	"max_retries",
	"httpProxy",
	"compact_model",
	"review_model",
	"approval",
	"sandbox",
	"max_turns",
	"spill_threshold",
	"ui",
	"mcp_servers",
	"plugins",
];

const UI_KEYS: readonly string[] = ["notify"];
const PLUGINS_KEYS: readonly string[] = ["disabled", "trusted"];
const MCP_SERVER_KEYS: readonly string[] = [
	"command",
	"args",
	"type",
	"url",
	"headers",
	"call_timeout_ms",
	"disabled",
];

/**
 * 一份配置文件的解析结果。
 *
 * 除了值本身，还保留原文与逐键的「写过没有」。合并用户级与项目级配置时要靠后者判断某个值
 * 是使用者显式写的，还是取了默认值——只看最终值会把「项目没写、用默认值」错当成「项目要求
 * 用默认值」，从而盖掉用户的设置。
 */
export class ConfigFile {
	readonly config: Config;
	readonly document: TomlDocument;
	readonly file: string;

	/** 只允许本模块构造：值已经过校验，别处绕过来会得到没校验过的配置。 */
	constructor(config: Config, document: TomlDocument, file: string) {
		this.config = config;
		this.document = document;
		this.file = file;
	}

	static parse(source: string, file: string): ConfigFile {
		return parseConfigFile(source, file);
	}

	static load(file: string = configFilePath()): ConfigFile {
		return parseConfigFile(readTextFile(file), file);
	}

	/** 该键在原文里是否被显式写过。 */
	has(path: readonly string[]): boolean {
		return this.document.get(path) !== undefined;
	}

	/** 键在原文中的位置，用于把「项目配置不许放宽某项」这类错误指到具体行列。 */
	locationOf(path: readonly string[]): { line?: number; column?: number } {
		return this.document.locationOf(path) ?? {};
	}
}

/** 解析并校验 config.toml 的内容。 */
export function parseConfig(source: string, file: string): Config {
	return ConfigFile.parse(source, file).config;
}

function parseConfigFile(source: string, file: string): ConfigFile {
	// 解析与校验两阶段的错误都要带上文件路径：缺了它使用者只能看到「第 3 行」，不知道是哪个文件
	return wrapParseErrors(file, () => {
		const document = new TomlDocument(source);

		assertNoUnknownKeys(document, [], TOP_LEVEL_KEYS);

		const provider = readString(document, ["provider"]);
		const model = readString(document, ["model"]);
		if (provider === undefined) throw new ConfigError("Missing provider");
		if (model === undefined) throw new ConfigError("Missing model");

		const config: Config = {
			provider,
			model,
			reasoningEffort: readEnum(document, ["reasoning_effort"], THINKING_LEVELS) ?? DEFAULT_REASONING_EFFORT,
			contextWindow: readInteger(document, ["context_window"], 1),
			maxTokens: readInteger(document, ["max_tokens"], 1),
			maxRetries: readInteger(document, ["max_retries"], 0) ?? DEFAULT_MAX_RETRIES,
			httpProxy: readString(document, ["httpProxy"]),
			compactModel: readString(document, ["compact_model"]),
			reviewModel: readString(document, ["review_model"]),
			approval: readEnum(document, ["approval"], APPROVAL_MODES) ?? DEFAULT_APPROVAL,
			sandbox: readEnum(document, ["sandbox"], SANDBOX_MODES) ?? DEFAULT_SANDBOX,
			maxTurns: readInteger(document, ["max_turns"], 1),
			spillThreshold: readInteger(document, ["spill_threshold"], 0) ?? DEFAULT_SPILL_THRESHOLD,
			ui: readUi(document),
			mcpServers: readMcpServers(document),
			plugins: readPlugins(document),
		};
		return new ConfigFile(config, document, file);
	});
}

/** 从磁盘读取。 */
export function loadConfig(file: string = configFilePath()): Config {
	return parseConfig(readTextFile(file), file);
}

export function readTextFile(file: string): string {
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		throw new ConfigError(`Cannot read file: ${describeError(error)}`, { file });
	}
	// 带 BOM 的文件在 Windows 上很常见，不该因此报解析错误
	return source.startsWith("\uFEFF") ? source.slice(1) : source;
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 解析阶段的错误补上文件路径，让所有配置错误都能报出「哪个文件的第几行第几列」。 */
export function wrapParseErrors<T>(file: string, action: () => T): T {
	try {
		return action();
	} catch (error) {
		if (error instanceof ConfigError) throw error.withFile(file);
		throw error;
	}
}

function describePath(path: readonly string[]): string {
	return path.join(".");
}

function locate(
	document: TomlDocument,
	path: readonly string[],
): { line?: number; column?: number } {
	return document.locationOf(path) ?? {};
}

function readUi(document: TomlDocument): UiConfig {
	assertNoUnknownKeys(document, ["ui"], UI_KEYS);
	return { notify: readEnum(document, ["ui", "notify"], NOTIFY_MODES) ?? DEFAULT_NOTIFY };
}

function readPlugins(document: TomlDocument): PluginsConfig {
	assertNoUnknownKeys(document, ["plugins"], PLUGINS_KEYS);
	return {
		disabled: readStringArray(document, ["plugins", "disabled"]) ?? [],
		trusted: readStringArray(document, ["plugins", "trusted"]) ?? [],
	};
}

function readMcpServers(document: TomlDocument): readonly McpServerConfig[] {
	const table = readTable(document, ["mcp_servers"]);
	if (table === undefined) return [];

	const servers: McpServerConfig[] = [];
	for (const name of Object.keys(table)) {
		const path = ["mcp_servers", name];
		assertNoUnknownKeys(document, path, MCP_SERVER_KEYS);
		servers.push(readMcpServer(document, name, path));
	}
	return servers;
}

function readMcpServer(document: TomlDocument, name: string, path: readonly string[]): McpServerConfig {
	const command = readString(document, [...path, "command"]);
	const url = readString(document, [...path, "url"]);
	const declaredType = readString(document, [...path, "type"]);

	if (command !== undefined && url !== undefined) {
		throw new ConfigError(`${describePath(path)} cannot set both command and url`, locate(document, path));
	}
	if (command === undefined && url === undefined) {
		throw new ConfigError(`${describePath(path)} needs either command or url`, locate(document, path));
	}

	let type: McpServerType;
	if (declaredType === undefined) {
		type = command === undefined ? "http" : "stdio";
	} else if (declaredType === "stdio" || declaredType === "http" || declaredType === "sse") {
		type = declaredType;
	} else {
		throw new ConfigError(
			`${describePath([...path, "type"])} must be one of stdio, http, sse`,
			locate(document, [...path, "type"]),
		);
	}

	if (type === "stdio" && command === undefined) {
		throw new ConfigError(`${describePath(path)} declared as stdio must set command`, locate(document, path));
	}
	if (type !== "stdio" && url === undefined) {
			throw new ConfigError(`${describePath(path)} declared as ${type} must set url`, locate(document, path));
	}

	return {
		name,
		type,
		command,
		args: readStringArray(document, [...path, "args"]) ?? [],
		url,
		headers: readStringMap(document, [...path, "headers"]) ?? {},
		callTimeoutMs: readInteger(document, [...path, "call_timeout_ms"], 1),
		disabled: readBoolean(document, [...path, "disabled"]) ?? false,
	};
}
