import { pluginKindLabel } from "../lib/format.ts";
import type { SettingsSnapshot } from "../protocol.ts";

/** 扩展管理里统一成一种行：插件、技能与 MCP 都按同一种形状展示。 */
export type ExtensionKind = "plugin" | "skill" | "mcp";

export interface ExtensionItem {
	readonly kind: ExtensionKind;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly meta: string;
	readonly disabled: boolean;
	/** MCP 的运行期连接状态；其他类型没有 */
	readonly status?: string;
	readonly detail?: string;
}

/** 把设置快照里的三类扩展摊平成清单；设置还没读到时返回空表。 */
export function extensionItems(settings: SettingsSnapshot | undefined): readonly ExtensionItem[] {
	if (settings === undefined) return [];
	return [
		...settings.plugins.map((plugin, index) => ({
			kind: "plugin" as const,
			key: `plugin:${plugin.name}:${index}`,
			name: plugin.name,
			description: "已装载的插件",
			meta: pluginKindLabel(plugin.kind),
			disabled: plugin.disabled,
		})),
		...settings.skills.map((skill) => ({
			kind: "skill" as const,
			key: `skill:${skill.path}`,
			name: skill.name,
			description: skill.description,
			meta: "技能",
			disabled: false,
		})),
		...settings.mcpServers.map((server) => ({
			kind: "mcp" as const,
			key: `mcp:${server.name}`,
			name: server.name,
			description: "MCP 服务器",
			meta: server.type,
			disabled: server.disabled,
			status: server.status,
			detail: server.detail,
		})),
	];
}

/** 名称、描述与类型都参与搜索；空查询返回原顺序。 */
export function filterExtensions(
	items: readonly ExtensionItem[],
	query: string,
): readonly ExtensionItem[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return items;
	return items.filter((item) =>
		[item.name, item.description, item.meta].some((value) => value.toLowerCase().includes(needle)),
	);
}

export function countExtensions(
	items: readonly ExtensionItem[],
): Readonly<Record<ExtensionKind, number>> {
	return {
		plugin: items.filter((item) => item.kind === "plugin").length,
		skill: items.filter((item) => item.kind === "skill").length,
		mcp: items.filter((item) => item.kind === "mcp").length,
	};
}

/** 个性化指令按 UTF-8 计字节：中文与模型实际读到的预算一致。 */
export function personalizationBytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** 计数器上的 KB；0 不显示小数，其余保留一位，和输入框右下角的读数一致。 */
export function formatKb(bytes: number): string {
	if (bytes === 0) return "0 KB";
	const kb = bytes / 1024;
	return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

/** 设置导航过滤：组内没有命中时整组隐藏，空查询保持原样。 */
export function filterSettingsNav<T extends { readonly label: string }>(
	groups: readonly { readonly label: string; readonly items: readonly T[] }[],
	query: string,
): readonly { readonly label: string; readonly items: readonly T[] }[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return groups;
	return groups
		.map((group) => ({
			label: group.label,
			items: group.items.filter((item) => item.label.toLowerCase().includes(needle)),
		}))
		.filter((group) => group.items.length > 0);
}

export type KeyValueParseResult =
	| { readonly ok: true; readonly value: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly error: string };

/** 把「每行一个 KEY=VALUE」的文本收成对象；空行忽略，缺等号的行直接报错。 */
export function parseKeyValueLines(text: string): KeyValueParseResult {
	const value: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) return { ok: false, error: `无法解析：${line}` };
		const key = line.slice(0, separator).trim();
		const item = line.slice(separator + 1).trim();
		if (key.length === 0) return { ok: false, error: `键不能为空：${line}` };
		value[key] = item;
	}
	return { ok: true, value };
}

/** 参数输入按行拆：每行一个参数，保留内部空格，去掉首尾空白与空行。 */
export function parseArgumentLines(text: string): readonly string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}
