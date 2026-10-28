import type { Config } from "./file.ts";

/**
 * 配置热更新的分界线。
 *
 * 只有「每轮重新读取」的项才能在运行中生效：客户端、压缩器、驱动都是每轮新建的，它们从配置
 * 里取值，值变了下一轮就是新的。审批方式、落盘阈值与通知方式虽然被常驻对象持有，但它们都有
 * 一个明确的即时生效点，由调用方在应用新配置时同步过去。其余项在启动时已经被别的对象拿走了
 * ——沙箱视图持有后端、MCP 连接持有 server 清单——改它们等于重做一次装配。
 *
 * 所以这里不假装全部能热更新：分不清的项一律归到「要重启」，宁可多要求一次重启，也不要
 * 悄悄生效一半。
 */
const LIVE_FIELDS: ReadonlySet<keyof Config> = new Set<keyof Config>([
	"reasoningEffort",
	"contextWindow",
	"maxTokens",
	"maxRetries",
	"streamIdleTimeout",
	"httpProxy",
	"compactModel",
	"reviewModel",
	"approval",
	"maxTurns",
	"spillThreshold",
	"compaction",
	"ui",
]);

interface ConfigDiff {
	/** 改完立刻就能生效的项 */
	readonly live: readonly (keyof Config)[];
	/** 要重启才能生效的项 */
	readonly restart: readonly (keyof Config)[];
}

export function diffConfig(before: Config, after: Config): ConfigDiff {
	const live: (keyof Config)[] = [];
	const restart: (keyof Config)[] = [];
	for (const key of Object.keys(after) as (keyof Config)[]) {
		if (sameValue(before[key], after[key])) continue;
		(LIVE_FIELDS.has(key) ? live : restart).push(key);
	}
	return { live, restart };
}

/**
 * 把能立刻生效的项换进当前配置，其余保持原样。
 *
 * 逐项写而不是循环赋值：`Config` 加字段时这里会跟着编译报错，不会悄悄漏掉一项。
 */
export function applyLiveConfig(
	current: Config,
	next: Config,
	fields: readonly (keyof Config)[],
): Config {
	const has = (field: keyof Config): boolean => fields.includes(field);
	return {
		...current,
		...(has("reasoningEffort") ? { reasoningEffort: next.reasoningEffort } : {}),
		...(has("contextWindow") ? { contextWindow: next.contextWindow } : {}),
		...(has("maxTokens") ? { maxTokens: next.maxTokens } : {}),
		...(has("maxRetries") ? { maxRetries: next.maxRetries } : {}),
		...(has("streamIdleTimeout") ? { streamIdleTimeout: next.streamIdleTimeout } : {}),
		...(has("httpProxy") ? { httpProxy: next.httpProxy } : {}),
		...(has("compactModel") ? { compactModel: next.compactModel } : {}),
		...(has("reviewModel") ? { reviewModel: next.reviewModel } : {}),
		...(has("approval") ? { approval: next.approval } : {}),
		...(has("maxTurns") ? { maxTurns: next.maxTurns } : {}),
		...(has("spillThreshold") ? { spillThreshold: next.spillThreshold } : {}),
		...(has("compaction") ? { compaction: next.compaction } : {}),
		...(has("ui") ? { ui: next.ui } : {}),
	};
}

/** 配置值都是可序列化的标量、数组与普通对象，按序列化结果比就够。 */
function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
