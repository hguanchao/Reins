import type { ReactElement } from "react";

import { formatCost, formatDuration, formatTokens } from "../lib/format.ts";
import type { ActivitySummary, UsageSummary } from "../protocol.ts";
import { Section, SettingsPane } from "./controls.tsx";

/**
 * 使用统计。
 *
 * 先给构成条再给数字：单看总量判断不了钱花在哪。构成条只用墨色深浅三档，不加彩色——
 * 这是数据图表，但分类色一旦引入就会稀释「彩色只属于 diff」的规则。
 */
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
	const total = Math.max(1, usage.input + usage.cacheRead + usage.cacheWrite + usage.output);
	const share = (value: number): number => Math.round((value / total) * 100);
	const inputSide = usage.input + usage.cacheRead + usage.cacheWrite;
	const hit = inputSide > 0 ? Math.round((usage.cacheRead / inputSide) * 100) : undefined;
	// 零值段不画：宽度 0 仍然会被 flex 撑出一小块色块，看着像有数据
	const segments = [
		{ key: "a", value: usage.input },
		{ key: "b", value: usage.cacheRead },
		{ key: "c", value: usage.output },
	].filter((segment) => segment.value > 0);

	return (
		<SettingsPane
			eyebrow="SETTINGS / USAGE"
			title="使用统计"
			description="当前任务的模型用量与工具活动；没有记录耗时的请求不进入耗时统计。"
		>
			<Section name="Token 用量" hint={`当前任务 · ${activity.turns} 轮 · ${activity.steps} 步`}>
				<div className="stat-grid">
					<div className="stat">
						<div className="k">请求</div>
						<div className="v">{usage.requests}</div>
					</div>
					<div className="stat">
						<div className="k">输入</div>
						<div className="v">{formatTokens(usage.input)}</div>
					</div>
					<div className="stat">
						<div className="k">输出</div>
						<div className="v">{formatTokens(usage.output)}</div>
					</div>
					<div className="stat">
						<div className="k">缓存读取</div>
						<div className="v">{formatTokens(usage.cacheRead)}</div>
						{hit === undefined ? null : <div className="h">命中 {hit}%</div>}
					</div>
					<div className="stat">
						<div className="k">缓存写入</div>
						<div className="v">{formatTokens(usage.cacheWrite)}</div>
					</div>
					<div className="stat">
						<div className="k">总 Token</div>
						<div className="v">{formatTokens(usage.total)}</div>
					</div>
				</div>
			</Section>

			<Section name="构成" hint="按 token 计">
				<div className="tkbar">
					{segments.map((segment) => (
						<i key={segment.key} className={segment.key} style={{ width: `${share(segment.value)}%` }} />
					))}
				</div>
				<div className="legend">
					<span>
						<i style={{ background: "var(--ink)" }} />输入 {formatTokens(usage.input)}
					</span>
					<span>
						<i style={{ background: "var(--ink-3)" }} />缓存读取 {formatTokens(usage.cacheRead)}
					</span>
					<span>
						<i style={{ background: "var(--ink-4)" }} />输出 {formatTokens(usage.output)}
					</span>
					{cost === undefined ? null : (
						<span style={{ marginLeft: "auto", fontFamily: "var(--mono)", color: "var(--ink-2)" }}>
							费用 {cost}
						</span>
					)}
				</div>
			</Section>

			<Section name="活动">
				<div className="stat-grid">
					<div className="stat">
						<div className="k">回合</div>
						<div className="v">{activity.turns}</div>
					</div>
					<div className="stat">
						<div className="k">主对话请求</div>
						<div className="v">{activity.steps}</div>
					</div>
					<div className="stat">
						<div className="k">模型耗时</div>
						<div className="v">{formatDuration(activity.llmMs)}</div>
					</div>
					<div className="stat">
						<div className="k">工具耗时</div>
						<div className="v">{formatDuration(activity.toolMs)}</div>
					</div>
					<div className="stat">
						<div className="k">平均首字延迟</div>
						<div className="v">{averageTtft === undefined ? "—" : formatDuration(Math.round(averageTtft))}</div>
					</div>
					<div className="stat">
						<div className="k">解码速度</div>
						<div className="v">
							{decodeSpeed === undefined ? "—" : Math.round(decodeSpeed)}
							{decodeSpeed === undefined ? null : <span className="u">tok/s</span>}
						</div>
					</div>
				</div>
			</Section>

			<Section name="按模型" hint="含子智能体">
				<div className="set-card">
					<div className="set-row um um-head">
						<span className="um-name">模型</span>
						<span className="um-col" style={{ width: 56 }}>
							请求
						</span>
						<span className="um-col" style={{ width: 80 }}>
							Token
						</span>
						<span className="um-col" style={{ width: 64 }}>
							费用
						</span>
					</div>
					<div className="set-row um">
						<span className="um-name">主对话</span>
						<span className="um-col" style={{ width: 56 }}>
							{usage.requests}
						</span>
						<span className="um-col" style={{ width: 80 }}>
							{formatTokens(usage.total)}
						</span>
						<span className="um-col" style={{ width: 64 }}>
							{cost ?? "—"}
						</span>
					</div>
				</div>
				<p className="set-note">子智能体的用量并入主对话；单模型拆分需要内核上报模型标识。</p>
			</Section>
		</SettingsPane>
	);
}
