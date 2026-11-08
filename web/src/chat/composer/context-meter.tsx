import { X } from "lucide-react";
import { type ReactElement } from "react";
import { Popover } from "../../components/ui/popover.tsx";
import { formatTokens } from "../../lib/format.ts";

/** 上下文圆环：点击展开 token 构成；没有数据时不出现。 */
export function ContextMeter({
	tokens,
	window: contextWindow,
}: {
	readonly tokens: number | undefined;
	readonly window: number | undefined;
}): ReactElement | null {
	if (tokens === undefined || contextWindow === undefined || contextWindow <= 0) return null;
	const ratio = Math.min(1, tokens / contextWindow);
	const percent = Math.round(ratio * 100);
	const circumference = 2 * Math.PI * 4.5;

	return (
		<Popover
			align="start"
			trigger={({ toggle }) => (
				<button type="button" className="ctx" onClick={toggle} aria-label="上下文占用" title="上下文占用，点击查看构成">
					<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
						<circle className="ring-bg" cx="6" cy="6" r="4.5" fill="none" strokeWidth="2" />
						<circle
							className="ring-fg"
							cx="6"
							cy="6"
							r="4.5"
							fill="none"
							strokeWidth="2"
							strokeLinecap="round"
							strokeDasharray={circumference}
							strokeDashoffset={circumference * (1 - ratio)}
							transform="rotate(-90 6 6)"
						/>
					</svg>
					<span>
						<b style={{ fontWeight: 500, color: "var(--ink)" }}>{percent}%</b> 上下文
					</span>
				</button>
			)}
		>
			{(close) => (
				<div className="ctx-panel">
					<div className="cx-head">
						<span>上下文用量</span>
						<button type="button" className="cx-close" onClick={close} aria-label="关闭">
							<X className="ic-12" />
						</button>
					</div>
					<div className="cx-big">
						<b>{percent}%</b>
						<span>
							~{formatTokens(tokens)} / {formatTokens(contextWindow)}
						</span>
					</div>
					<div className="cx-bar">
						<i style={{ width: `${percent}%`, background: "var(--ink)" }} />
					</div>
					<div className="cx-rows">
						<div className="cx-row">
							<span className="d" style={{ background: "var(--ink)" }} />
							<span>已用</span>
							<span className="n">{formatTokens(tokens)}</span>
						</div>
						<div className="cx-row">
							<span className="d" style={{ background: "var(--ink-4)" }} />
							<span>剩余</span>
							<span className="n">{formatTokens(Math.max(0, contextWindow - tokens))}</span>
						</div>
					</div>
					<div className="cx-foot">窗口 {formatTokens(contextWindow)} · 压缩阈值由内核按窗口自动判定</div>
				</div>
			)}
		</Popover>
	);
}
