import type { UsageSummary } from "../protocol.ts";

/** 用量条目事件;与协议里的 usage_recorded 事件同形。 */
export interface UsageRecorded {
	readonly tokens: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost?: number;
}

/**
 * 把一笔新落盘的用量累进会话汇总。
 *
 * 界面靠快照拿到全量,靠事件拿到增量;两边口径一致才能直接相加——事件里同样只带提供方
 * 回报的分项,合计沿用事件的 tokens,不自己拼分项(各提供方对 input 的定义并不一致)。
 */
export function applyUsageRecorded(current: UsageSummary, event: UsageRecorded): UsageSummary {
	return {
		requests: current.requests + 1,
		input: current.input + event.input,
		output: current.output + event.output,
		cacheRead: current.cacheRead + event.cacheRead,
		cacheWrite: current.cacheWrite + event.cacheWrite,
		total: current.total + event.tokens,
		cost: mergeCost(current.cost, event.cost),
	};
}

/** 金额只有一边有就取有的一边;两边都有才相加,缺单价的一笔不能把已知的金额抹掉。 */
function mergeCost(current: number | undefined, incoming: number | undefined): number | undefined {
	if (current === undefined) return incoming;
	if (incoming === undefined) return current;
	return current + incoming;
}
