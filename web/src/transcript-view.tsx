import type { ReactElement } from "react";

import type { Line } from "./transcript";

/** 会话流的渲染;一行一个组件分支,markdown 渲染与折叠组留给后续版本。 */
export function TranscriptView({ lines }: { lines: readonly Line[] }): ReactElement {
	return (
		<div className="transcript">
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
					<span className="marker">❯</span>
					<span className="text">{line.text}</span>
				</div>
			);
		case "assistant":
			return line.text.length === 0 ? null : <div className="line assistant">{line.text}</div>;
		case "thinking":
			return (
				<details className="line thinking">
					<summary>思考</summary>
					<div className="body">{line.text}</div>
				</details>
			);
		case "tool":
			return (
				<details className={"line tool" + (line.isError ? " error" : "")}>
					<summary>
						<span className={"mark " + (line.running ? "run" : line.isError ? "bad" : "ok")}>
							{line.running ? "◌" : line.isError ? "×" : "✓"}
						</span>
						<span className="name">{line.name}</span>
						{line.summary !== undefined && <span className="summary">{line.summary}</span>}
						{line.durationMs !== undefined && (
							<span className="duration">{formatDuration(line.durationMs)}</span>
						)}
					</summary>
					{line.detail.length > 0 && <pre className="body">{line.detail}</pre>}
				</details>
			);
		case "notice":
			return <div className={"line notice " + line.tone}>{line.text}</div>;
	}
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
