import { readFileSync } from "node:fs";

import { describeError } from "../shared/describe-error.ts";
import { ConfigError } from "./error.ts";
import { aliasOf } from "./keys.ts";
import { configFilePath } from "./paths.ts";
import {
	assertNoUnknownKeys,
	describePath,
	locate,
	readBoolean,
	readEnum,
	readInteger,
	readNumber,
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

const NOTIFY_MODES: readonly NotifyMode[] = ["auto", "bell", "desktop", "off"];

/** MCP server 的接入形态：stdio 起本地进程，http 与 sse 连远程端点。 */
type McpServerType = "stdio" | "http" | "sse";

/** type 字段的合法取值,解析校验与提示共用这一份清单。 */
const MCP_SERVER_TYPES = ["stdio", "http", "sse"] as const satisfies readonly McpServerType[];

export interface McpServerConfig {
	readonly name: string;
	readonly type: McpServerType;
	/** 仅 stdio 使用 */
	readonly command: string | undefined;
	readonly args: readonly string[];
	/** 仅 http 与 sse 使用 */
	readonly url: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
	/** 只作用于 tools/call，单位秒；连接与控制请求用的是固定的短超时 */
	readonly timeoutSeconds: number | undefined;
	readonly disabled: boolean;
}

interface PluginsConfig {
	readonly disabled: readonly string[];
	/** 已信任的工作区根，由 --trust 与信任页回写 */
	readonly trusted: readonly string[];
}

interface UiConfig {
	readonly notify: NotifyMode;
}

/** 上下文压缩的触发与保留策略。 */
interface CompactionConfig {
	/** 上下文用到窗口的这个比例就压缩，0 到 1 之间（不含 0） */
	readonly compactAt: number;
	/** 压缩后保留最近这一比例的原文，0 到 1 之间 */
	readonly keepRecent: number;
	/** 摘要请求的总时限（秒）；0 表示不限 */
	readonly summaryTimeout: number;
}

export interface Config {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort: ThinkingLevel;
	/** providers.json 里模型没声明时可以在这里兜底；两处都没有则无法计算压缩阈值 */
	readonly contextWindow: number | undefined;
	readonly maxTokens: number | undefined;
	readonly maxRetries: number;
	/** 流式响应允许的最长静默（秒）；0 表示不限，读到对端关闭为止 */
	readonly streamIdleTimeout: number;
	/** 显式空串表示强制直连 */
	readonly httpProxy: string | undefined;
	/** 自定义 shell 路径；省略时按平台自动查找 Git Bash */
	readonly shellPath: string | undefined;
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
	readonly compaction: CompactionConfig;
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
/** 压缩策略的默认值：用到八成压缩，压完留最近两成半原文，摘要不设总时限。 */
const DEFAULT_COMPACT_AT = 0.8;
const DEFAULT_KEEP_RECENT = 0.25;
const DEFAULT_SUMMARY_TIMEOUT = 0;

const TOP_LEVEL_KEYS: readonly string[] = [
	"provider",
	"model",
	"reasoning_effort",
	"context_window",
	"max_tokens",
	"max_retries",
	"stream_idle_timeout",
	"httpProxy",
	"shellPath",
	"compact_model",
	"review_model",
	"approval",
	"sandbox",
	"max_turns",
	"spill_threshold",
	"compaction",
	"ui",
	"mcp_servers",
	"plugins",
];

const UI_KEYS: readonly string[] = ["notify"];
const COMPACTION_KEYS: readonly string[] = ["compact_at", "keep_recent", "summary_timeout"];
const PLUGINS_KEYS: readonly string[] = ["disabled", "trusted"];
const MCP_SERVER_KEYS: readonly string[] = [
	"command",
	"args",
	"type",
	"url",
	"headers",
	"timeout",
	"disabled",
];

/**
 * 同一配置项的两种写法：camelCase 与 snake_case。
 *
 * 配置读取一律先找主名称、再找别名；两个都写且值不同就报错。表名（mcp_servers）与
 * MCP 条目里的字段也按同一张表处理。
 */

function aliasPath(path: readonly string[]): readonly string[] | undefined {
	const key = path[path.length - 1];
	const alias = key === undefined ? undefined : aliasOf(key);
	return alias === undefined ? undefined : [...path.slice(0, -1), alias];
}

/** 允许键列表同时包含主名称与别名，未知键的报错也会把两种写法列出来。 */
function withAliases(keys: readonly string[]): readonly string[] {
	const all = new Set(keys);
	for (const key of keys) {
		const alias = aliasOf(key);
		if (alias !== undefined) all.add(alias);
	}
	return [...all];
}

const TOP_LEVEL_ALLOWED = withAliases(TOP_LEVEL_KEYS);
const MCP_SERVER_ALLOWED = withAliases(MCP_SERVER_KEYS);
const COMPACTION_ALLOWED = withAliases(COMPACTION_KEYS);

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
		return parseConfigFile(source, file, false);
	}

	static load(file: string = configFilePath()): ConfigFile {
		return parseConfigFile(readTextFile(file), file, false);
	}

	/**
	 * 读项目级配置。
	 *
	 * 项目配置只覆盖它写了的项，其余沿用用户配置，所以不要求它自带 provider/model：
	 * 一份只想改压缩阈值的项目配置不该被迫抄一遍完整的模型选择，抄了反而会盖掉使用者的选择。
	 */
	static loadProject(file: string): ConfigFile {
		return parseConfigFile(readTextFile(file), file, true);
	}

	/** 该键在原文里是否被显式写过；别名也算。 */
	has(path: readonly string[]): boolean {
		if (this.document.get(path) !== undefined) return true;
		const alternate = aliasPath(path);
		return alternate !== undefined && this.document.get(alternate) !== undefined;
	}

	/** 键在原文中的位置，用于把「项目配置不许放宽某项」这类错误指到具体行列。 */
	locationOf(path: readonly string[]): { line?: number; column?: number } {
		return this.document.locationOf(path) ?? this.document.locationOf(aliasPath(path) ?? path) ?? {};
	}
}

/** 解析并校验 config.toml 的内容。 */
export function parseConfig(source: string, file: string): Config {
	return ConfigFile.parse(source, file).config;
}

function parseConfigFile(source: string, file: string, partial: boolean): ConfigFile {
	// 解析与校验两阶段的错误都要带上文件路径：缺了它使用者只能看到「第 3 行」，不知道是哪个文件
	return wrapParseErrors(file, () => {
		const document = new TomlDocument(source);

		assertNoUnknownKeys(document, [], TOP_LEVEL_ALLOWED);

		const provider = readString(document, ["provider"]);
		const model = readString(document, ["model"]);
		// 项目配置允许只写要覆盖的项。占位空串不会外泄：合并时按「原文里写没写这个键」取值，
		// 没写的项一律沿用用户配置。
		if (!partial) {
			if (provider === undefined) throw new ConfigError("Missing provider");
			if (model === undefined) throw new ConfigError("Missing model");
		}

		const config: Config = {
			provider: provider ?? "",
			model: model ?? "",
			reasoningEffort:
				readEnumField(document, ["reasoning_effort"], THINKING_LEVELS) ?? DEFAULT_REASONING_EFFORT,
			contextWindow: readIntegerField(document, ["context_window"], 1),
			maxTokens: readIntegerField(document, ["max_tokens"], 1),
			maxRetries: readIntegerField(document, ["max_retries"], 0) ?? DEFAULT_MAX_RETRIES,
			streamIdleTimeout: readIntegerField(document, ["stream_idle_timeout"], 0) ?? 0,
			httpProxy: readStringField(document, ["httpProxy"]),
			shellPath: readStringField(document, ["shellPath"]) || undefined,
			compactModel: readStringField(document, ["compact_model"]),
			reviewModel: readStringField(document, ["review_model"]),
			approval: readEnum(document, ["approval"], APPROVAL_MODES) ?? DEFAULT_APPROVAL,
			sandbox: readEnum(document, ["sandbox"], SANDBOX_MODES) ?? DEFAULT_SANDBOX,
			maxTurns: readIntegerField(document, ["max_turns"], 1),
			spillThreshold:
				readIntegerField(document, ["spill_threshold"], 0) ?? DEFAULT_SPILL_THRESHOLD,
			compaction: readCompaction(document),
			ui: readUi(document),
			mcpServers: readMcpServers(document),
			plugins: readPlugins(document),
		};
		return new ConfigFile(config, document, file);
	});
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

/** 解析阶段的错误补上文件路径，让所有配置错误都能报出「哪个文件的第几行第几列」。 */
export function wrapParseErrors<T>(file: string, action: () => T): T {
	try {
		return action();
	} catch (error) {
		if (error instanceof ConfigError) throw error.withFile(file);
		throw error;
	}
}

function readUi(document: TomlDocument): UiConfig {
	assertNoUnknownKeys(document, ["ui"], UI_KEYS);
	return { notify: readEnum(document, ["ui", "notify"], NOTIFY_MODES) ?? DEFAULT_NOTIFY };
}

function readCompaction(document: TomlDocument): CompactionConfig {
	assertNoUnknownKeys(document, ["compaction"], COMPACTION_ALLOWED);
	return {
		compactAt: readRatio(document, ["compaction", "compact_at"], true) ?? DEFAULT_COMPACT_AT,
		keepRecent: readRatio(document, ["compaction", "keep_recent"], false) ?? DEFAULT_KEEP_RECENT,
		summaryTimeout:
			readIntegerField(document, ["compaction", "summary_timeout"], 0) ?? DEFAULT_SUMMARY_TIMEOUT,
	};
}

/**
 * 读一个 0 到 1 之间的比例。
 *
 * 上界必须校验：比例超过 1 时阈值会跑到窗口外面，表现为「永远不压缩」或「每轮都压缩」，
 * 比直接报错难查得多。
 */
function readRatio(
	document: TomlDocument,
	path: readonly string[],
	exclusiveMinimum: boolean,
): number | undefined {
	const value = readAliased(document, path, (source, sourcePath) => readNumber(source, sourcePath, 0));
	if (value === undefined) return undefined;
	const name = describePath(path);
	if (value > 1) throw new ConfigError(`${name} must be at most 1`);
	if (exclusiveMinimum && value === 0) throw new ConfigError(`${name} must be greater than 0`);
	return value;
}

/**
 * 读取一个可能有两种写法的字段。
 *
 * 主名称优先；别名存在时也读，两边都写且值不同就报错。只支持标量，表与数组由调用方
 * 单独处理。
 */
function readAliased<T>(
	document: TomlDocument,
	path: readonly string[],
	read: (source: TomlDocument, path: readonly string[]) => T | undefined,
): T | undefined {
	const value = read(document, path);
	const key = path[path.length - 1];
	const alias = key === undefined ? undefined : aliasOf(key);
	if (alias === undefined) return value;

	const aliasPath = [...path.slice(0, -1), alias];
	const alternate = read(document, aliasPath);
	if (value !== undefined && alternate !== undefined && !Object.is(value, alternate)) {
		throw new ConfigError(
			`${describePath(path)} and ${describePath(aliasPath)} must match when both are set`,
			locate(document, path),
		);
	}
	return value ?? alternate;
}

function readStringField(document: TomlDocument, path: readonly string[]): string | undefined {
	return readAliased(document, path, readString);
}

function readIntegerField(
	document: TomlDocument,
	path: readonly string[],
	minimum: number,
): number | undefined {
	return readAliased(document, path, (source, sourcePath) => readInteger(source, sourcePath, minimum));
}

function readEnumField<T extends string>(
	document: TomlDocument,
	path: readonly string[],
	allowed: readonly T[],
): T | undefined {
	return readAliased(document, path, (source, sourcePath) => readEnum(source, sourcePath, allowed));
}

function readPlugins(document: TomlDocument): PluginsConfig {
	assertNoUnknownKeys(document, ["plugins"], PLUGINS_KEYS);
	return {
		disabled: readStringArray(document, ["plugins", "disabled"]) ?? [],
		trusted: readStringArray(document, ["plugins", "trusted"]) ?? [],
	};
}

function readMcpServers(document: TomlDocument): readonly McpServerConfig[] {
	const tableNames = (["mcp_servers", "mcpServers"] as const).filter(
		(name) => document.get([name]) !== undefined,
	);
	if (tableNames.length > 1) {
		throw new ConfigError(
			"Use only one of mcp_servers and mcpServers",
			locate(document, ["mcp_servers"]),
		);
	}
	const tableName = tableNames[0];
	if (tableName === undefined) return [];
	const table = readTable(document, [tableName]);
	if (table === undefined) return [];

	const servers: McpServerConfig[] = [];
	for (const name of Object.keys(table)) {
		const path = [tableName, name];
		assertNoUnknownKeys(document, path, MCP_SERVER_ALLOWED);
		servers.push(readMcpServer(document, name, path));
	}
	return servers;
}

function readMcpServer(document: TomlDocument, name: string, path: readonly string[]): McpServerConfig {
	const command = readString(document, [...path, "command"]);
	const url = readString(document, [...path, "url"]);

	if (command !== undefined && url !== undefined) {
		throw new ConfigError(`${describePath(path)} cannot set both command and url`, locate(document, path));
	}
	if (command === undefined && url === undefined) {
		throw new ConfigError(`${describePath(path)} needs either command or url`, locate(document, path));
	}

	// 枚举校验走 readEnum,非法取值能报出「哪个键必须是哪几个值之一」
	const type: McpServerType =
		readEnum(document, [...path, "type"], MCP_SERVER_TYPES) ?? (command === undefined ? "http" : "stdio");

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
		timeoutSeconds: readInteger(document, [...path, "timeout"], 1),
		disabled: readBoolean(document, [...path, "disabled"]) ?? false,
	};
}
