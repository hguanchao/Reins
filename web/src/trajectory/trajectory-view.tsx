import { Route } from "lucide-react";
import type { ReactElement } from "react";

import { formatDuration } from "../lib/format.ts";
import type { Line } from "../transcript/lines.ts";
import { summarizeTurns } from "./trajectory-model.ts";

/** 轨迹页：按轮次列出输入、回答、工具调用与耗时。 */
export function TrajectoryView({ lines }: { readonly lines: readonly Line[] }): ReactElement {
	const turns = summarizeTurns(lines);

	if (turns.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-[13px] leading-5 text-foreground-subtlest">
				<Route className="size-7 text-foreground-subtlest" />
				<span>这一轮还没有运行轨迹</span>
			</div>
		);
	}

	return (
		<div className="min-h-0 flex-1 overflow-auto px-7 pb-8 pt-4">
			<table className="w-full border-collapse text-[13px] leading-5">
				<thead>
					<tr className="border-b-[0.5px] border-border text-left text-[12px] leading-[18px] text-foreground-subtlest">
						<th className="w-14 py-2 pr-3 font-normal">轮次</th>
						<th className="py-2 pr-3 font-normal">输入</th>
						<th className="py-2 pr-3 font-normal">回答</th>
						<th className="w-20 py-2 pr-3 font-normal">工具</th>
						<th className="w-24 py-2 font-normal">耗时</th>
					</tr>
				</thead>
				<tbody>
					{turns.map((turn) => (
						<tr
							key={turn.turn}
							className="border-b-[0.5px] border-border/70 transition-colors hover:bg-surface-hover"
						>
							<td className="py-2.5 pr-3 font-mono text-[12px] tabular-nums text-foreground-subtle">
								{turn.turn}
							</td>
							<td className="max-w-[260px] truncate py-2.5 pr-3 text-foreground" title={turn.user}>
								{turn.user.length === 0 ? "—" : turn.user}
							</td>
							<td className="max-w-[320px] truncate py-2.5 pr-3 text-foreground-subtle" title={turn.assistant}>
								{turn.assistant.length === 0 ? "—" : turn.assistant}
							</td>
							<td className="py-2.5 pr-3 text-foreground-subtle">
								{turn.toolCount}
								{turn.failedTools === 0 ? null : (
									<span className="ml-1 text-[11px] text-destructive">({turn.failedTools} 失败)</span>
								)}
							</td>
							<td className="py-2.5 font-mono text-[12px] tabular-nums text-foreground-subtle">
								{turn.durationMs === 0 ? "—" : formatDuration(turn.durationMs)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
