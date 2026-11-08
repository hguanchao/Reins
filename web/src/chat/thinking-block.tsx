import { Brain } from "lucide-react";
import { useState, type ReactElement } from "react";

/**
 * 思考块。
 *
 * 左侧一条 1px 细线，头部一行元读数；默认折叠，点击整行开合，不设箭头。运行中图标脉动、
 * 文字扫光，收起时也看得出还在思考。折叠行照设计稿显示「思考了 8 秒」：秒数来自内核随
 * 条目记录的思考耗时；旧会话没有这份记录，退为「已思考」——不拿字数凑数。
 */
export function ThinkingBlock({
	text,
	streaming,
	durationMs,
}: {
	readonly text: string;
	readonly streaming: boolean;
	readonly durationMs?: number;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const seconds =
		durationMs === undefined
			? undefined
			: durationMs < 10_000
				? (durationMs / 1000).toFixed(1).replace(/\.0$/, "")
				: String(Math.round(durationMs / 1000));
	const label = streaming ? "思考中…" : seconds === undefined ? "已思考" : `思考了 ${seconds} 秒`;
	return (
		<div className={`think${open ? " open" : ""}${streaming ? " live" : ""}`}>
			<button type="button" className="th-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
				<Brain className="ic ic-12" />
				<span className={streaming ? "lbl" : undefined}>{label}</span>
			</button>
			<div className="th-body">{text}</div>
		</div>
	);
}
