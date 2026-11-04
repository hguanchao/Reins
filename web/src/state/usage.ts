import type { ActivitySummary, UsageSummary } from "../protocol.ts";

/** 用量条目事件;与协议里的 usage_recorded 事件同形。 */
export interface UsageRecorded {
	/** 主对话回合还是上下文压缩;活动统计只认回合 */
	readonly kind: string;
	readonly tokens: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly llmMs?: number;
	readonly ttftMs?: number;
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

/** 活动事件的计时部分;耗时没记到的请求(压缩、旧会话)不进累计。 */
export interface ActivityRecorded {
	readonly kind: string;
	readonly llmMs?: number;
	readonly ttftMs?: number;
	readonly output?: number;
}

/** 一笔带计时的请求落盘后累进活动统计;压缩请求不是主对话的一步,不计。 */
export function applyActivityRecorded(current: ActivitySummary, event: ActivityRecorded): ActivitySummary {
	if (event.kind !== "turn") return current;
	return {
		...current,
		steps: current.steps + 1,
		llmMs: current.llmMs + (event.llmMs ?? 0),
		decodeTokens: current.decodeTokens + (event.llmMs === undefined ? 0 : (event.output ?? 0)),
		decodeMs: current.decodeMs + (event.llmMs === undefined ? 0 : Math.max(0, event.llmMs - (event.ttftMs ?? 0))),
		ttftMs: current.ttftMs + (event.ttftMs ?? 0),
		ttftCount: current.ttftCount + (event.ttftMs === undefined ? 0 : 1),
	};
}

/** 一个工具跑完(含未执行的拒绝与参数错误,耗时记 0)后累进工具耗时。 */
export function applyToolDuration(current: ActivitySummary, durationMs: number): ActivitySummary {
	return { ...current, toolMs: current.toolMs + Math.max(0, durationMs) };
}
