import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { McpServerConfig } from "#src/config/file.ts";
import { pluginsDir } from "#src/config/paths.ts";
import type { PluginReportLine } from "#src/plugins/host.ts";
import { describeError } from "#src/shared/describe-error.ts";

/**
 * 声明式插件。
 *
 * 与 external.ts 装载的代码插件不同：这类插件不执行任何插件代码，只提供文件——技能目录、
 * 命令与子代理的 Markdown、MCP 服务声明。Claude Code 与 pi 的插件包都是这个形态，所以同一份
 * 发现逻辑能同时认出两家的包。
 *
 * 清单按上游工具的习惯查找：`plugin.json` → `.reins-plugin/plugin.json` →
 * `.claude-plugin/plugin.json` → `package.json` 的 `pi` 字段 → 都没有时按约定目录推导。
 * 认得出但宿主没有对应机制的部件（hooks、LSP、主题、提示词模板）不静默丢弃，一律写进
 * 报告让使用者知道。
 */

/** 一个插件声明的技能目录；single 表示该目录本身就是一个技能（里面直接放 SKILL.md）。 */
export interface PluginSkillDirectory {
	readonly directory: string;
	readonly single: boolean;
}

export interface DeclarativePlugin {
	readonly name: string;
	readonly root: string;
	/** 清单来自哪个文件；按约定目录推导时写 "convention" */
	readonly manifest: string;
	readonly skillDirectories: readonly PluginSkillDirectory[];
	readonly mcpServers: readonly McpServerConfig[];
	/** pi 扩展的入口文件（绝对路径）；由 pi-runtime 装载 */
	readonly extensions: readonly string[];
	/** 依赖 @deepseek-ai/cordis 的 dsh 插件；由 dsh-runtime 装载 */
	readonly cordis: boolean;
	/** 已识别但没有对应机制的部件，一句人话 */
	readonly unsupported: readonly string[];
	readonly warnings: readonly string[];
}

export interface DeclarativeFailure {
	readonly plugin: string;
	readonly message: string;
}

export interface DeclarativeScan {
	readonly plugins: readonly DeclarativePlugin[];
	readonly failures: readonly DeclarativeFailure[];
}

/** 扫描插件目录下的所有子目录。不是目录的条目、没有清单的目录都不算插件。 */
export function scanDeclarativePlugins(directory: string = pluginsDir()): DeclarativeScan {
	const plugins: DeclarativePlugin[] = [];
	const failures: DeclarativeFailure[] = [];
	const seen = new Map<string, string>();

	for (const entry of subdirectories(directory)) {
		const root = join(directory, entry);
		let plugin: DeclarativePlugin | undefined;
		try {
			plugin = readPlugin(root, entry);
		} catch (error) {
			failures.push({ plugin: entry, message: describeError(error) });
			continue;
		}
		if (plugin === undefined) continue;

		const existing = seen.get(plugin.name);
		if (existing !== undefined) {
			failures.push({
				plugin: entry,
				message: `Plugin name ${plugin.name} is already used by ${existing}`,
			});
			continue;
		}
		seen.set(plugin.name, entry);
		plugins.push(plugin);
	}

	return { plugins, failures };
}

/**
 * 把插件的 MCP 声明并进配置里的服务清单。
 *
 * 配置是使用者自己写的，重名时以配置为准：插件不该能顶掉一条已经配好的连接。
 */
export function mergeMcpServers(
	configured: readonly McpServerConfig[],
	plugins: readonly DeclarativePlugin[],
): { readonly servers: readonly McpServerConfig[]; readonly warnings: readonly string[] } {
	const servers = [...configured];
	const names = new Set(configured.map((server) => server.name));
	const warnings: string[] = [];

	for (const plugin of plugins) {
		for (const server of plugin.mcpServers) {
			if (names.has(server.name)) {
				warnings.push(
					`Plugin ${plugin.name}: MCP server ${server.name} is already configured; the plugin's declaration is ignored`,
				);
				continue;
			}
			names.add(server.name);
			servers.push(server);
		}
	}
	return { servers, warnings };
}

interface Manifest {
	readonly file: string;
	readonly name: string;
	readonly skills: readonly string[];
	readonly commands: readonly string[];
	readonly agents: readonly string[];
	readonly extensions: readonly string[];
	readonly mcpFile: string | undefined;
	readonly mcpInline: unknown;
	readonly unsupported: readonly string[];
}

/** 清单文件名与所在子目录，按优先级排列。 */
const MANIFESTS: readonly { readonly file: string; readonly directory: string }[] = [
	{ file: "plugin.json", directory: "" },
	{ file: "plugin.json", directory: ".reins-plugin" },
	{ file: "plugin.json", directory: ".claude-plugin" },
];

/** 约定目录：没有清单时靠它们认出这是一个插件。 */
const CONVENTIONS: readonly { readonly path: string; readonly label: string }[] = [
	{ path: "skills", label: "skills/" },
	{ path: "commands", label: "commands/" },
	{ path: "agents", label: "agents/" },
	{ path: ".mcp.json", label: ".mcp.json" },
	{ path: join("hooks", "hooks.json"), label: "hooks/hooks.json" },
];

function readPlugin(root: string, directoryName: string): DeclarativePlugin | undefined {
	const packageJson = readJsonFile(join(root, "package.json"));
	const cordis = isCordisPlugin(packageJson);

	const manifest = readManifest(root, directoryName, packageJson);
	if (manifest === undefined) {
		// Cordis 包不写 plugin.json 也不带约定目录：package.json 本身就是它的清单
		if (!cordis) return undefined;
		return {
			name: text(packageJson?.["name"]) ?? directoryName,
			root,
			manifest: "package.json",
			skillDirectories: [],
			mcpServers: [],
			extensions: entryFiles(packageJson, root, []),
			cordis,
			unsupported: [],
			warnings: [],
		};
	}

	const warnings: string[] = [];
	const skills = resolveSkillDirectories(root, manifest.skills, warnings);
	const declaredExtensions = manifest.extensions.length > 0 ? manifest.extensions : entryFiles(packageJson, root, manifest.extensions);
	const extensions = resolveExtensionFiles(root, declaredExtensions, warnings);
	const mcp = readMcpServers(manifest, root, warnings);
	const unsupported = [...manifest.unsupported];

	if (manifest.commands.length > 0) {
		unsupported.push(`commands (${manifest.commands.length} path(s)): Reins has no prompt-command mechanism yet`);
	}
	if (manifest.agents.length > 0) {
		unsupported.push(`agents (${manifest.agents.length} path(s)): Reins subagents are code-defined`);
	}

	return {
		name: manifest.name,
		root,
		manifest: manifest.file,
		skillDirectories: skills,
		mcpServers: mcp,
		extensions,
		cordis,
		unsupported,
		warnings,
	};
}

/** Cordos 包的入口：main 字段，缺省时按 index 的常见名字找。 */
function entryFiles(
	packageJson: Record<string, unknown> | undefined,
	root: string,
	fallback: readonly string[],
): readonly string[] {
	if (fallback.length > 0) return fallback;
	if (packageJson === undefined) return [];
	const main = text(packageJson["main"]) ?? text((packageJson["exports"] as Record<string, unknown> | undefined)?.["."]);
	if (main !== undefined) return [main];
	for (const candidate of ["index.js", "index.ts"]) {
		if (isFile(join(root, candidate))) return [candidate];
	}
	return [];
}

/** 是否依赖 Cordis 容器：这类插件按 dsh 语义装载，由 dsh-runtime 提供 ctx。 */
function isCordisPlugin(packageJson: Record<string, unknown> | undefined): boolean {
	if (packageJson === undefined) return false;
	for (const field of ["peerDependencies", "dependencies"] as const) {
		const dependencies = packageJson[field];
		if (isObject(dependencies) && "@deepseek-ai/cordis" in dependencies) return true;
	}
	return false;
}

function readManifest(
	root: string,
	directoryName: string,
	packageJson: Record<string, unknown> | undefined,
): Manifest | undefined {
	for (const candidate of MANIFESTS) {
		const file = join(root, candidate.directory, candidate.file);
		const document = readJsonFile(file);
		if (document === undefined) continue;
		if (!isObject(document)) throw new Error(`${relative(root, file)} must contain a JSON object`);
		return claudeManifest(document, relative(root, file), directoryName);
	}

	const pi = packageJson === undefined ? undefined : packageJson["pi"];
	if (isObject(pi)) return piManifest(pi, "package.json#pi", directoryName);

	return conventionManifest(root, directoryName);
}

/** Claude Code 风格的清单：字段是相对插件根的路径。 */
function claudeManifest(document: Record<string, unknown>, file: string, fallbackName: string): Manifest {
	const unsupported: string[] = [];
	if (document["hooks"] !== undefined) unsupported.push("hooks: Reins has no hook event points");
	if (document["lspServers"] !== undefined) unsupported.push("lspServers: Reins has no language-server integration");

	const mcp = document["mcpServers"];
	const mcpFile = typeof mcp === "string" ? mcp : undefined;
	return {
		file,
		name: text(document["name"]) ?? fallbackName,
		skills: paths(document["skills"]),
		commands: paths(document["commands"]),
		agents: paths(document["agents"]),
		extensions: [],
		mcpFile,
		mcpInline: typeof mcp === "string" ? undefined : mcp,
		unsupported,
	};
}

/** pi 包的清单：`package.json` 里的 `pi` 字段，全是相对包根的路径。 */
function piManifest(pi: Record<string, unknown>, file: string, fallbackName: string): Manifest {
	const unsupported: string[] = [];
	const prompts = paths(pi["prompts"]);
	if (prompts.length > 0) unsupported.push(`prompts (${prompts.length}): Reins has no prompt templates`);
	const themes = paths(pi["themes"]);
	if (themes.length > 0) unsupported.push(`themes (${themes.length}): Reins has a fixed palette`);

	return {
		file,
		name: fallbackName,
		skills: paths(pi["skills"]),
		commands: [],
		agents: [],
		extensions: paths(pi["extensions"]),
		mcpFile: undefined,
		mcpInline: undefined,
		unsupported,
	};
}

/** 没有清单时按约定目录推导；一个约定目录都没有就不是插件。 */
function conventionManifest(root: string, directoryName: string): Manifest | undefined {
	const present = CONVENTIONS.filter((entry) => exists(join(root, entry.path)));
	if (present.length === 0) return undefined;

	const unsupported = present
		.filter((entry) => entry.path.startsWith("hooks"))
		.map(() => "hooks: Reins has no hook event points");
	const hasSkills = present.some((entry) => entry.path === "skills");
	const hasCommands = present.some((entry) => entry.path === "commands");
	const hasAgents = present.some((entry) => entry.path === "agents");
	const hasMcp = present.some((entry) => entry.path === ".mcp.json");

	return {
		file: "convention",
		name: directoryName,
		skills: hasSkills ? ["skills"] : [],
		commands: hasCommands ? ["commands"] : [],
		agents: hasAgents ? ["agents"] : [],
		extensions: [],
		mcpFile: hasMcp ? ".mcp.json" : undefined,
		mcpInline: undefined,
		unsupported,
	};
}

/**
 * 把声明里的技能路径解析成技能根。
 *
 * 两种形态都要认：父目录（下面每个子目录是一个技能，Reins 自己的约定）与单个技能目录
 * （pi 的 `pi.skills` 常写成 `./skills/pdf`）。路径逃出插件根的一律跳过——插件目录是外部
 * 输入，不该能指到插件之外。
 */
function resolveSkillDirectories(
	root: string,
	paths: readonly string[],
	warnings: string[],
): readonly PluginSkillDirectory[] {
	const directories: PluginSkillDirectory[] = [];
	for (const path of paths) {
		const absolute = contained(root, path);
		if (absolute === undefined) {
			warnings.push(`Skill path ${path} escapes the plugin root; skipped`);
			continue;
		}
		if (!isDirectory(absolute)) {
			warnings.push(`Skill path ${path} is not a directory; skipped`);
			continue;
		}
		// 目录里直接有 SKILL.md 就是单个技能，否则当父目录扫一层
		directories.push({ directory: absolute, single: isFile(join(absolute, "SKILL.md")) });
	}
	return directories;
}

/** 把声明里的扩展入口解析成文件；路径逃出根或不是文件时跳过并告警。 */
function resolveExtensionFiles(root: string, paths: readonly string[], warnings: string[]): readonly string[] {
	const files: string[] = [];
	for (const path of paths) {
		const absolute = contained(root, path);
		if (absolute === undefined) {
			warnings.push(`Extension path ${path} escapes the plugin root; skipped`);
			continue;
		}
		if (!isFile(absolute)) {
			warnings.push(`Extension path ${path} is not a file; skipped`);
			continue;
		}
		files.push(absolute);
	}
	return files;
}

function readMcpServers(manifest: Manifest, root: string, warnings: string[]): readonly McpServerConfig[] {
	let document: unknown = manifest.mcpInline;
	if (manifest.mcpFile !== undefined) {
		const absolute = contained(root, manifest.mcpFile);
		if (absolute === undefined) {
			warnings.push(`MCP file ${manifest.mcpFile} escapes the plugin root; skipped`);
			return [];
		}
		document = readJsonFile(absolute);
		if (document === undefined) {
			warnings.push(`MCP file ${manifest.mcpFile} does not exist; skipped`);
			return [];
		}
	}
	if (document === undefined || document === null) return [];
	if (!isObject(document)) throw new Error(`${manifest.file}: mcpServers must be an object or a path`);

	const table = isObject(document["mcpServers"]) ? document["mcpServers"] : document;
	const servers: McpServerConfig[] = [];
	for (const [name, raw] of Object.entries(table)) {
		servers.push(toServerConfig(name, raw));
	}
	return servers;
}

/** 一条 MCP 声明转成配置结构；形态不成立就抛错，不猜一个可能连错的端点。 */
function toServerConfig(name: string, raw: unknown): McpServerConfig {
	if (!isObject(raw)) throw new Error(`MCP server ${name} must be an object`);

	const command = text(raw["command"]);
	const url = text(raw["url"]);
	if (command !== undefined && url !== undefined) {
		throw new Error(`MCP server ${name} cannot set both command and url`);
	}
	if (command === undefined && url === undefined) {
		throw new Error(`MCP server ${name} needs either command or url`);
	}

	const declared = text(raw["type"]);
	const type = declared ?? (command === undefined ? "http" : "stdio");
	if (type !== "stdio" && type !== "http" && type !== "sse") {
		throw new Error(`MCP server ${name} has an unsupported type: ${type}`);
	}
	if (type === "stdio" && command === undefined) {
		throw new Error(`MCP server ${name} declared as stdio must set command`);
	}
	if (type !== "stdio" && url === undefined) {
		throw new Error(`MCP server ${name} declared as ${type} must set url`);
	}

	const timeout = raw["timeout"];
	return {
		name,
		type,
		command,
		args: strings(raw["args"]),
		url,
		headers: stringMap(raw["headers"]),
		env: stringMap(raw["env"]),
		timeoutSeconds: typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0 ? timeout : undefined,
		disabled: raw["disabled"] === true,
	};
}

/**
 * 装载报告。
 *
 * 每个插件一行结论，后面跟不支持与告警的原因。插件装上了但某一项没生效时，使用者要能直接
 * 看出是哪一项、为什么——静默丢弃会让人以为插件根本没用。
 */
export function describeDeclarativeScan(
	scan: DeclarativeScan,
	mcpWarnings: readonly string[] = [],
): readonly PluginReportLine[] {
	const lines: PluginReportLine[] = [];
	for (const plugin of scan.plugins) {
		const parts: string[] = [];
		if (plugin.skillDirectories.length > 0) parts.push(`${plugin.skillDirectories.length} skill dir(s)`);
		if (plugin.mcpServers.length > 0) parts.push(`${plugin.mcpServers.length} MCP server(s)`);
		if (plugin.extensions.length > 0) parts.push(`${plugin.extensions.length} extension(s)`);
		lines.push({
			text: `plugin ${plugin.name} (${plugin.manifest}): ${parts.length === 0 ? "nothing usable" : parts.join(", ")}`,
			problem: false,
		});
		for (const item of plugin.unsupported) {
			lines.push({ text: `plugin ${plugin.name}: unsupported — ${item}`, problem: true });
		}
		for (const warning of plugin.warnings) {
			lines.push({ text: `plugin ${plugin.name}: ${warning}`, problem: true });
		}
	}
	for (const failure of scan.failures) {
		lines.push({ text: `plugin ${failure.plugin}: failed — ${failure.message}`, problem: true });
	}
	lines.push(...mcpWarnings.map((text) => ({ text, problem: true })));
	return lines;
}

function subdirectories(directory: string): readonly string[] {
	let entries: readonly string[];
	try {
		entries = readdirSync(directory);
	} catch {
		// 没有插件目录是正常状态：大多数人不会写插件
		return [];
	}
	return entries.filter((entry) => isDirectory(join(directory, entry))).sort();
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error(`${basename(path)} is not valid JSON: ${describeError(error)}`);
	}
	return isObject(parsed) ? parsed : undefined;
}

/** 相对插件根的路径；逃出根目录时返回 undefined。 */
function contained(root: string, candidate: string): string | undefined {
	const absolute = resolve(root, candidate);
	const rel = relative(root, absolute);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return absolute;
}

function exists(path: string): boolean {
	return isDirectory(path) || isFile(path);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 清单字段可写成单个路径或路径数组。 */
function paths(value: unknown): readonly string[] {
	if (typeof value === "string") return [value];
	return strings(value);
}

function strings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
	if (!isObject(value)) return {};
	const entries: [string, string][] = [];
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") entries.push([key, item]);
	}
	return Object.fromEntries(entries);
}
