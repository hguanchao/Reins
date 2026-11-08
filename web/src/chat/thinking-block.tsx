import { Sparkles } from "lucide-react";
import { useState, type ReactElement } from "react";

/**
 * 思考块。
 *
 * 左侧一条 1px 细线，头部一行摘要；默认折叠，点击整行开合，不设箭头。运行中图标脉动、
 * 文字扫光，收起时也看得出还在思考。
 */
export function ThinkingBlock({
	text,
	streaming,
	summary,
}: {
	readonly text: string;
	readonly streaming: boolean;
	readonly summary?: string;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const label = streaming ? "思考中…" : (summary ?? "已思考");
	return (
		<div className={`think${open ? " open" : ""}${streaming ? " live" : ""}`}>
			<button type="button" className="th-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
				<Sparkles className="ic-12" />
				<span className={streaming ? "lbl" : undefined}>{label}</span>
			</button>
			<div className="th-body">{text}</div>
		</div>
	);
}
