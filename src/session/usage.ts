import type { LlmUsage } from "../llm/messages.ts";
import type { SessionEntry } from "./port.ts";

/**
 * 会话的用量统计。
 *
 * 只认用量条目，不看上下文：被压缩掉的历史同样计入——那些 token 是真的花掉的，压缩改变的
 * 只是「接下来发什么」，不改变已经发生的事。金额不在这里算：配置面里没有价格，硬凑一个
 * 数字只会比 token 更容易骗人。
 *
 * 「一次请求占了多少窗口」也归在这里：压缩判断与界面显示问的是同一个问题，口径必须一致。
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
	/** 金额（美元）。一笔单价都没有时为空——不拿 0 冒充「不要钱」 */
	readonly cost: number | undefined;
	/** 有多少笔请求没算进金额：模型没配单价 */
	readonly unpriced: number;
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
		cost: 0,
		priced: 0,
		unpriced: 0,
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

		if (entry.cost === undefined) totals.unpriced += 1;
		else {
			totals.cost += entry.cost;
			totals.priced += 1;
		}
	}
	return {
		requests: totals.requests,
		compactions: totals.compactions,
		subagents: totals.subagents,
		input: totals.input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		total: totals.total,
		// 一笔都没配单价时不给金额：一个 0 会被读成「没花钱」
		cost: totals.priced === 0 ? undefined : totals.cost,
		unpriced: totals.unpriced,
	};
}

/**
 * 缓存命中率：缓存读取占全部输入侧 token 的比例。
 *
 * 输入侧由未命中缓存的新输入、缓存读取和缓存写入三部分组成；输出不经过缓存，不参与计算。
 * 一次请求都没有时没有命中率可言，返回 0，避免把「还没有数据」显示成 100%。
 */
export function cacheHitRate(totals: UsageTotals): number {
	const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;
	return inputSide === 0 ? 0 : totals.cacheRead / inputSide;
}

/**
 * 一次请求结束时上下文有多大。
 *
 * 取提供方回报的合计：它就是「这次请求的提示词 + 这次生成的输出」，缓存命中的部分同样占着
 * 窗口，只是便宜。不按分项自己拼——各提供方对 input 的定义并不一致，有的把缓存算在里面，
 * 有的不算，拼一次就可能少算或重复算一大截。
 */
export function contextTokens(usage: LlmUsage): number {
	return usage.total;
}

/**
 * 会话记录里能反映当前上下文规模的那笔用量。
 *
 * 从最近往前找，跳过两类条目：子代理的请求算的是另一处上下文，与主对话无关；压缩之后窗口
 * 已被摘要取代，真实规模要等下一次请求，所以遇到压缩条目就停下，交给调用方按消息估算。
 */
export function lastContextTokens(entries: readonly SessionEntry[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "usage") continue;
		if (entry.kind === "compact") return undefined;
		if (entry.kind === "turn") return contextTokens(entry.usage);
	}
	return undefined;
}

/** 把用量写成人看的一行，界面上与导出里都用它。 */
export function describeUsage(totals: UsageTotals): string {
	const breakdown: string[] = [];
	if (totals.compactions > 0) breakdown.push(`compactions: ${totals.compactions}`);
	if (totals.subagents > 0) breakdown.push(`subagents: ${totals.subagents}`);
	const detail = breakdown.length === 0 ? "" : ` (${breakdown.join(", ")})`;
	const tokens =
		`requests: ${totals.requests}${detail}  input: ${totals.input}  output: ${totals.output}  ` +
		`cache read: ${totals.cacheRead}  cache write: ${totals.cacheWrite}  total: ${totals.total} tokens`;
	if (totals.cost === undefined) return tokens;

	// 没配单价的那几笔要说明白：只说金额会让人以为这就是全部开销
	const missing = totals.unpriced === 0 ? "" : ` (${totals.unpriced} requests unpriced, not counted)`;
	return `${tokens}  cost: ${formatCost(totals.cost)}${missing}`;
}

/**
 * 金额的显示精度。
 *
 * 按量级选小数位：便宜的模型一次请求可能只有万分之几美元，固定四位会一律显示成 0。
 */
function formatCost(value: number): string {
	return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}
