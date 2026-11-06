import { stripVTControlCharacters } from "node:util";

/**
 * 插件运行日志。
 *
 * 插件是外部代码，不能保证只输出干净的一行：ANSI 转义、控制字符、超长消息都要在入口
 * 收掉，否则界面排版会被撑坏。日志只放内存，重启即清空——它是排障用的旁路，不是审计记录。
 */

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export interface PluginLogLine {
	readonly at: string;
	readonly level: PluginLogLevel;
	readonly message: string;
}

/** 界面一次最多看这么多条；与缓冲区上限保持一致。 */
export const PLUGIN_LOG_LIMIT = 200;

const MAX_MESSAGE_CHARS = 4_000;
const MAX_PLUGINS = 200;
const LEVELS: readonly PluginLogLevel[] = ["debug", "info", "warn", "error"];

export class PluginLogBuffer {
	/** Map 的插入顺序就是插件首次出现的顺序；超出上限时淘汰最早的那个 */
	readonly #lines = new Map<string, PluginLogLine[]>();

	record(plugin: string, level: PluginLogLevel, message: string): void {
		const text = sanitize(message);
		if (text.length === 0) return;
		const safeLevel = LEVELS.includes(level) ? level : "info";
		let bucket = this.#lines.get(plugin);
		if (bucket === undefined) {
			if (this.#lines.size >= MAX_PLUGINS) {
				const oldest = this.#lines.keys().next().value;
				if (oldest !== undefined) this.#lines.delete(oldest);
			}
			bucket = [];
			this.#lines.set(plugin, bucket);
		}
		bucket.push({ at: new Date().toISOString(), level: safeLevel, message: text });
		if (bucket.length > PLUGIN_LOG_LIMIT) bucket.splice(0, bucket.length - PLUGIN_LOG_LIMIT);
	}

	/** 按时间顺序返回最近的 limit 条；插件没有日志时返回空表。 */
	lines(plugin: string, limit: number = PLUGIN_LOG_LIMIT): readonly PluginLogLine[] {
		const bucket = this.#lines.get(plugin);
		if (bucket === undefined) return [];
		const requested = Number.isFinite(limit) ? Math.floor(limit) : PLUGIN_LOG_LIMIT;
		const count = Math.max(1, Math.min(PLUGIN_LOG_LIMIT, requested));
		return bucket.slice(-count);
	}
}

/** 去掉 ANSI 转义与控制字符，把换行压成空格；日志是单行展示。 */
function sanitize(message: string): string {
	return stripVTControlCharacters(message)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/\r?\n/g, " ")
		.trim()
		.slice(0, MAX_MESSAGE_CHARS);
}
