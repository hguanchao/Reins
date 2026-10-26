/**
 * 同一配置项的两种写法：camelCase 与 snake_case。
 *
 * 配置读取一律先找主名称、再找别名；两个都写且值不同就报错。表名（mcp_servers）与
 * MCP 条目里的字段也按同一张表处理。
 *
 * 这张表要独立成一个模块：读取方（配置校验）与回写方（保留原文的 TOML 文档）都必须认识
 * 别名，而两者分属不同目录，互相导入会形成循环。
 */

export const KEY_ALIASES: Readonly<Record<string, string>> = {
	reasoning_effort: "reasoningEffort",
	context_window: "contextWindow",
	max_tokens: "maxTokens",
	max_retries: "maxRetries",
	stream_idle_timeout: "streamIdleTimeout",
	http_proxy: "httpProxy",
	shell_path: "shellPath",
	compact_model: "compactModel",
	review_model: "reviewModel",
	max_turns: "maxTurns",
	spill_threshold: "spillThreshold",
	compact_at: "compactAt",
	keep_recent: "keepRecent",
	summary_timeout: "summaryTimeout",
	mcp_servers: "mcpServers",
};

const ALIAS_LOOKUP = new Map<string, string>(
	Object.entries(KEY_ALIASES).flatMap(([snake, camel]) => [
		[snake, camel],
		[camel, snake],
	]),
);

/** 该键的另一种写法；没有别名时返回 undefined。 */
export function aliasOf(key: string): string | undefined {
	return ALIAS_LOOKUP.get(key);
}
