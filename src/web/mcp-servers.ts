import type { McpServerConfig } from "#src/config/file.ts";
import type { ConfigTable } from "#src/config/value.ts";

/**
 * 从设置页新增 MCP server 的输入校验。
 *
 * 配置文件仍由 config/file.ts 做最终解析；这里只把 HTTP 表单的松散值收窄成可写进配置的
 * 形状，并挡住明显会让宿主起不来的组合（stdio 没命令、http 没地址、名字含路径分隔符）。
 */

export type McpServerType = "stdio" | "http" | "sse";

const SERVER_TYPES: readonly McpServerType[] = ["stdio", "http", "sse"];
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
const MAX_PAIRS = 64;
const MAX_PAIR_VALUE_CHARS = 8192;

export type McpServerDraft =
	| {
			readonly name: string;
			readonly type: "stdio";
			readonly command: string;
			readonly args: readonly string[];
			readonly env: Readonly<Record<string, string>>;
	  }
	| {
			readonly name: string;
			readonly type: "http" | "sse";
			readonly url: string;
			readonly headers: Readonly<Record<string, string>>;
	  };

export interface McpServerDraftResult {
	readonly ok: boolean;
	readonly draft?: McpServerDraft;
	readonly error?: string;
}

export interface McpServerNameResult {
	readonly ok: boolean;
	readonly name?: string;
	readonly error?: string;
}

/** 只校验 server 名；详情、删除与重连不需要整份配置。 */
export function parseMcpServerName(value: unknown): McpServerNameResult {
	if (typeof value !== "string" || value.trim().length === 0) {
		return { ok: false, error: "请填写名称" };
	}
	const name = value.trim();
	if (!SERVER_NAME.test(name)) {
		return { ok: false, error: "名称只能使用字母、数字、- 和 _" };
	}
	return { ok: true, name };
}

/** 把配置里的 server 还原成表单形状；编辑时用来预填。 */
export function mcpServerDraft(server: McpServerConfig): McpServerDraft {
	if (server.type === "stdio") {
		return {
			name: server.name,
			type: "stdio",
			command: server.command ?? "",
			args: server.args,
			env: server.env,
		};
	}
	return {
		name: server.name,
		type: server.type,
		url: server.url ?? "",
		headers: server.headers,
	};
}

export function parseMcpServerInput(body: Record<string, unknown>): McpServerDraftResult {
	const rawName = body["name"];
	if (typeof rawName !== "string" || rawName.trim().length === 0) {
		return { ok: false, error: "请填写名称" };
	}
	const name = rawName.trim();
	if (!SERVER_NAME.test(name)) {
		return { ok: false, error: "名称只能使用字母、数字、- 和 _" };
	}

	const type = body["type"];
	if (typeof type !== "string" || !SERVER_TYPES.includes(type as McpServerType)) {
		return { ok: false, error: `传输方式必须是以下之一：${SERVER_TYPES.join("、")}` };
	}

	if (type === "stdio") {
		const command = readString(body["command"]);
		if (command === undefined) return { ok: false, error: "stdio 需要填写启动命令" };
		const args = readStringArray(body["args"]);
		if (!args.ok) return { ok: false, error: args.error };
		const env = readStringMap(body["env"]);
		if (!env.ok) return { ok: false, error: `环境变量：${env.error}` };
		return {
			ok: true,
			draft: { name, type: "stdio", command, args: args.value, env: env.value },
		};
	}

	const url = readString(body["url"]);
	if (url === undefined) return { ok: false, error: "http 与 sse 需要填写地址" };
	if (!isHttpUrl(url)) return { ok: false, error: "地址必须是完整的 http(s) 地址" };
	const headers = readStringMap(body["headers"]);
	if (!headers.ok) return { ok: false, error: `请求头：${headers.error}` };
	return {
		ok: true,
		draft: { name, type: type as "http" | "sse", url, headers: headers.value },
	};
}

/** 写进 config.toml 的字段：只保留该传输方式真正用得到的键。 */
export function mcpServerTable(draft: McpServerDraft): ConfigTable {
	if (draft.type === "stdio") {
		return {
			type: draft.type,
			command: draft.command,
			...(draft.args.length === 0 ? {} : { args: [...draft.args] }),
			...(Object.keys(draft.env).length === 0 ? {} : { env: { ...draft.env } }),
		};
	}
	return {
		type: draft.type,
		url: draft.url,
		...(Object.keys(draft.headers).length === 0 ? {} : { headers: { ...draft.headers } }),
	};
}

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function readStringArray(value: unknown): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly error: string } {
	if (value === undefined) return { ok: true, value: [] };
	if (!Array.isArray(value)) return { ok: false, error: "参数必须是数组" };
	if (value.length > MAX_ARGS) return { ok: false, error: `参数不能超过 ${MAX_ARGS} 项` };
	const args: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return { ok: false, error: "参数必须是字符串" };
		if (item.length > MAX_ARG_CHARS) {
			return { ok: false, error: `单个参数不能超过 ${MAX_ARG_CHARS} 个字符` };
		}
		args.push(item);
	}
	return { ok: true, value: args };
}

function readStringMap(value: unknown): { readonly ok: true; readonly value: Readonly<Record<string, string>> } | { readonly ok: false; readonly error: string } {
	if (value === undefined) return { ok: true, value: {} };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "格式必须是对象" };
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_PAIRS) return { ok: false, error: `不能超过 ${MAX_PAIRS} 项` };
	const result: Record<string, string> = {};
	for (const [key, item] of entries) {
		if (key.length === 0) return { ok: false, error: "键不能为空" };
		if (typeof item !== "string") return { ok: false, error: "值必须是字符串" };
		if (item.length > MAX_PAIR_VALUE_CHARS) {
			return { ok: false, error: `单个值不能超过 ${MAX_PAIR_VALUE_CHARS} 个字符` };
		}
		result[key] = item;
	}
	return { ok: true, value: result };
}
