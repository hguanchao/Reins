import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describeError } from "#src/shared/describe-error.ts";
import { ConfigError } from "#src/config/error.ts";
import { configFilePath } from "#src/config/paths.ts";
import { serializeKey, serializeValue } from "#src/config/toml/serialize.ts";
import { TomlDocument } from "#src/config/toml/index.ts";
import type { ConfigTable, ConfigValue } from "#src/config/value.ts";

/**
 * 用户级配置的定点回写。
 *
 * 有三处配置由程序自己写：工作区的信任清单、通知方式与模型选择。它们都得写在**用户级**
 * 配置里，因为前两项决定的正是「一个目录能不能影响程序行为」——放在项目配置里，等于让
 * 不受信任的目录自己把门打开；模型选择则是使用者在 /model 里做出的显式决定。
 *
 * 回写走保留原文的 TOML 文档：使用者写下的注释与排版是他自己的东西，程序改一个键没有理由
 * 把它们冲掉。
 */

/**
 * 改用户级配置里的一个键。
 *
 * update 拿到当前值（没有就是 undefined），返回要写进去的值。先算好再落盘：算出错时文件
 * 保持原样，不会留下改到一半的配置。
 */
export function updateUserConfigValue(
	path: readonly string[],
	update: (current: ConfigValue | undefined) => ConfigValue,
	file: string = configFilePath(),
): void {
	mutateUserConfig(file, (document) => {
		const next = update(document.get(path));
		document.set([...path], next);
	});
}

/**
 * 把模型选择写回配置。
 *
 * provider 与 model 在一次写入里改完：分两次写会在中间留下一个指向不存在模型的组合，
 * 恰好被另一个进程读到时就成了一份坏配置。
 */
export function updateModelSelection(
	provider: string,
	model: string,
	file: string = configFilePath(),
): void {
	mutateUserConfig(file, (document) => {
		document.set(["provider"], provider);
		document.set(["model"], model);
	});
}

/** 读出原文、执行修改、再一次性写回；任何一步失败都不落盘。 */
function mutateUserConfig(file: string, mutate: (document: TomlDocument) => void): void {
	let document: TomlDocument;
	let hasBom = false;
	try {
		const source = existsSync(file) ? readFileSync(file, "utf8") : "";
		// 读路径会剥 BOM，写路径必须也剥：否则解析器在第一个字符就报 Missing key name，
		// 而这份文件明明能正常启动。
		hasBom = source.startsWith("\uFEFF");
		document = new TomlDocument(hasBom ? source.slice(1) : source);
	} catch (error) {
		throw new ConfigError(`无法读取配置：${describeError(error)}`, { file });
	}

	try {
		mkdirSync(dirname(file), { recursive: true });
		mutate(document);
		// 先写临时文件再改名：writeFileSync 会先截断，写一半失败就毁掉了使用者唯一的一份配置。
		const content = hasBom ? `\uFEFF${document.source}` : document.source;
		const temporary = `${file}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, content, "utf8");
			renameSync(temporary, file);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	} catch (error) {
		throw new ConfigError(`无法写入配置：${describeError(error)}`, { file });
	}
}

/** 配置里 MCP 表实际用的写法；新增、编辑与删除都必须写回同一种。 */
function mcpTableName(document: TomlDocument): string {
	if (document.get(["mcp_servers"]) !== undefined) return "mcp_servers";
	if (document.get(["mcpServers"]) !== undefined) return "mcpServers";
	return "mcp_servers";
}

/**
 * 追加一个 MCP server 段。
 *
 * MCP server 在配置里是以名字为键的表，已有 `[mcp_servers.old]` 段时定点写入新键会被
 * 文档模型拒绝，因此这里直接追加一个完整段，保留原有注释与排版。新文本先解析一遍：
 * `mcp_servers` 写成内联表时不能再扩展成分节，这种情况要报错而不是留下坏配置。
 */
export function appendMcpServerSection(
	name: string,
	values: Readonly<ConfigTable>,
	file: string = configFilePath(),
): void {
	const source = existsSync(file) ? readFileSync(file, "utf8") : "";
	const hasBom = source.startsWith("\uFEFF");
	const body = hasBom ? source.slice(1) : source;
	const document = new TomlDocument(body);
	const tableName = mcpTableName(document);
	if (document.get([tableName, name]) !== undefined) {
		throw new ConfigError(`MCP 服务器 ${name} 已存在`, { file });
	}

	const lines = [
		`[${serializeKey(tableName)}.${serializeKey(name)}]`,
		...Object.entries(values).map(
			([key, value]) => `${serializeKey(key)} = ${serializeValue(value)}`,
		),
	];
	const separator = body.length === 0 ? "" : body.endsWith("\n") ? "\n" : "\n\n";
	const next = `${body}${separator}${lines.join("\n")}\n`;
	try {
		new TomlDocument(next);
	} catch (error) {
		throw new ConfigError(`无法追加 MCP 服务器：${describeError(error)}`, { file });
	}

	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, hasBom ? `\uFEFF${next}` : next, "utf8");
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw new ConfigError(`无法写入配置：${describeError(error)}`, { file });
	}
}

/**
 * 替换一个已有 MCP server 段。
 *
 * 只重写目标段：其他 server 的注释与排版不动。timeout、disabled 这类表单不暴露的字段
 * 由调用方先并进 values，避免编辑一次就把它们丢掉。
 */
export function updateMcpServerSection(
	name: string,
	values: Readonly<ConfigTable>,
	file: string = configFilePath(),
): void {
	mutateUserConfig(file, (document) => {
		const tableName = mcpTableName(document);
		if (document.get([tableName, name]) === undefined) {
			throw new ConfigError(`MCP 服务器 ${name} 不存在`, { file });
		}
		document.replaceSection([tableName, name], { ...values });
	});
}

/** 删除一个已有 MCP server 段。 */
export function removeMcpServerSection(name: string, file: string = configFilePath()): void {
	mutateUserConfig(file, (document) => {
		const tableName = mcpTableName(document);
		if (document.get([tableName, name]) === undefined) {
			throw new ConfigError(`MCP 服务器 ${name} 不存在`, { file });
		}
		document.removeSection([tableName, name]);
	});
}

