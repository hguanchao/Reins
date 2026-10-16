import type { SessionEntry } from "./port.ts";

/**
 * 会话的用量统计。
 *
 * 只认用量条目，不看上下文：被压缩掉的历史同样计入——那些 token 是真的花掉的，压缩改变的
 * 只是「接下来发什么」，不改变已经发生的事。金额不在这里算：配置面里没有价格，硬凑一个
 * 数字只会比 token 更容易骗人。
 */

export interface UsageTotals {
	/** 记录到的请求次数 */
	readonly requests: number;
	/** 其中用于压缩上下文的次数 */
	readonly compactions: number;
	/** 其中由子代理发出的次数 */
	readonly subagents: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

export function sumUsage(entries: readonly SessionEntry[]): UsageTotals {
	const totals = {
		requests: 0,
		compactions: 0,
		subagents: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	for (const entry of entries) {
		if (entry.type !== "usage") continue;
		totals.requests += 1;
		if (entry.kind === "compact") totals.compactions += 1;
		if (entry.kind === "subagent") totals.subagents += 1;
		totals.input += entry.usage.input;
		totals.output += entry.usage.output;
		totals.cacheRead += entry.usage.cacheRead;
		totals.cacheWrite += entry.usage.cacheWrite;
		totals.total += entry.usage.total;
	}
	return totals;
}

/** 把用量写成人看的一行，界面上与导出里都用它。 */
export function describeUsage(totals: UsageTotals): string {
	const breakdown: string[] = [];
	if (totals.compactions > 0) breakdown.push(`压缩 ${totals.compactions} 次`);
	if (totals.subagents > 0) breakdown.push(`子代理 ${totals.subagents} 次`);
	const detail = breakdown.length === 0 ? "" : `（其中${breakdown.join("、")}）`;
	return (
		`请求 ${totals.requests} 次${detail}　输入 ${totals.input}　输出 ${totals.output}　` +
		`缓存读 ${totals.cacheRead}　缓存写 ${totals.cacheWrite}　合计 ${totals.total} token`
	);
}
