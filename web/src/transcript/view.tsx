import { Check, CircleDashed, X } from "lucide-react";
import type { ReactElement } from "react";

import { handleCopyClick } from "./markdown.ts";
import { MarkdownView } from "./markdown-view.tsx";
import type { Line } from "./lines.ts";

/** 会话流的渲染:视觉按 zai-light 复刻——用户右对齐气泡、助手 markdown 全宽、工具行式摘要。 */
export function TranscriptView({ lines }: { lines: readonly Line[] }): ReactElement {
	return (
		<div
			className="transcript"
			onClick={(event) => {
				handleCopyClick(event.nativeEvent);
			}}
		>
			{lines.map((line, index) => (
				<LineView key={index} line={line} />
			))}
		</div>
	);
}

function LineView({ line }: { line: Line }): ReactElement | null {
	switch (line.kind) {
		case "user":
			return (
				<div className="line user">
					<div className="bubble">{line.text}</div>
				</div>
			);
		case "assistant":
			return line.text.trim().length === 0 ? null : (
				<div className="line assistant">
					<MarkdownView text={line.text} streaming={line.open} />
				</div>
			);
		case "thinking":
			// 流式中的思考默认展开:真空期里这是唯一说明「还在干活」的东西
			return (
				<details className="line thinking" open={line.open}>
					<summary>
						<span className={line.open ? "grad-text" : undefined}>
							{line.open ? "思考中" : "已思考"}
						</span>
					</summary>
					<div className="body">{line.text}</div>
				</details>
			);
		case "tool":
			return (
				<details className={"line tool" + (line.running ? " running" : "") + (line.isError ? " error" : "")}>
					<summary>
						<span className={"glyph" + (line.running ? "" : line.isError ? " bad" : " ok")}>
							{line.running ? (
								<CircleDashed size={14} className="spin" />
							) : line.isError ? (
								<X size={14} />
							) : (
								<Check size={14} />
							)}
						</span>
						<span className={"tname" + (line.running ? " grad-text" : "")}>{line.name}</span>
						{line.summary !== undefined && <span className="tsummary">{line.summary}</span>}
						{line.durationMs !== undefined && <span className="tduration">{formatDuration(line.durationMs)}</span>}
					</summary>
					{line.detail.length > 0 && <div className="tbody">{line.detail}</div>}
				</details>
			);
		case "notice":
			return (
				<div className={"line notice " + line.tone}>
					<div className="bubble">{line.text}</div>
				</div>
			);
	}
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
