import type { ReactElement } from "react";

import { formatCost, formatDuration, formatTokens } from "../lib/format.ts";
import type { ActivitySummary, UsageSummary } from "../protocol.ts";
import { SettingsCard, SettingsHeader } from "./controls.tsx";

/** 使用统计：当前会话的 token 用量与活动耗时。 */
export function UsageSection({
	usage,
	activity,
}: {
	readonly usage: UsageSummary;
	readonly activity: ActivitySummary;
}): ReactElement {
	const cost = formatCost(usage.cost);
	const averageTtft = activity.ttftCount > 0 ? activity.ttftMs / activity.ttftCount : undefined;
	const decodeSpeed = activity.decodeMs > 0 ? activity.decodeTokens / (activity.decodeMs / 1000) : undefined;

	return (
		<div className="flex flex-col gap-7">
			<SettingsHeader
				title="使用统计"
				description="当前任务的模型用量与工具活动；没有记录耗时的请求不会进入耗时统计。"
			/>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">Token 用量</h2>
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					<StatCard label="请求" value={String(usage.requests)} />
					<StatCard label="输入" value={formatTokens(usage.input)} />
					<StatCard label="输出" value={formatTokens(usage.output)} />
					<StatCard label="缓存读取" value={formatTokens(usage.cacheRead)} />
					<StatCard label="缓存写入" value={formatTokens(usage.cacheWrite)} />
					<StatCard label="总 Token" value={formatTokens(usage.total)} />
					<StatCard
						label="费用"
						value={cost ?? "—"}
						hint={cost === undefined ? "部分请求未配置单价" : undefined}
					/>
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">活动</h2>
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					<StatCard label="回合" value={String(activity.turns)} />
					<StatCard label="主对话请求" value={String(activity.steps)} />
					<StatCard label="模型耗时" value={formatDuration(activity.llmMs)} />
					<StatCard label="工具耗时" value={formatDuration(activity.toolMs)} />
					<StatCard
						label="平均首字延迟"
						value={averageTtft === undefined ? "—" : formatDuration(Math.round(averageTtft))}
					/>
					<StatCard
						label="解码速度"
						value={decodeSpeed === undefined ? "—" : `${decodeSpeed.toFixed(1)} tok/s`}
					/>
				</div>
			</section>

			<p className="m-0 px-1 text-[11px] leading-4 text-foreground-subtlest">
				统计随当前任务累计；切换任务后从新的任务重新计算。
			</p>
		</div>
	);
}

function StatCard({
	label,
	value,
	hint,
}: {
	readonly label: string;
	readonly value: string;
	readonly hint?: string;
}): ReactElement {
	return (
		<SettingsCard className="gap-0 px-4 py-3.5">
			<span className="text-[11px] leading-4 text-foreground-subtlest">{label}</span>
			<span className="mt-1 text-[20px] leading-7 font-medium tabular-nums">{value}</span>
			{hint === undefined ? null : (
				<span className="mt-0.5 text-[11px] leading-4 text-foreground-subtlest">{hint}</span>
			)}
		</SettingsCard>
	);
}
