import { Info } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";
import { groupToolRuns, type Line } from "../transcript/lines.ts";
import { MarkdownView } from "../transcript/markdown-view.tsx";
import { ThinkingBlock } from "./thinking-block.tsx";
import { ToolCallRow } from "./tool-call-row.tsx";
import { UserMessage } from "./user-message.tsx";

/** 会话流：用户气泡、助手 Markdown、思考块、连续工具行与提示。 */
export function TranscriptView({ lines }: { readonly lines: readonly Line[] }): ReactElement {
	const blocks = groupToolRuns(lines);
	return (
		<div className="flex flex-col gap-6" aria-live="polite">
			{blocks.map((block, index) =>
				block.kind === "tools" ? (
					<div key={`tools-${index}`} className="flex flex-col gap-1.5">
						{block.items.map((item) => (
							<ToolCallRow key={item.callId} line={item} />
						))}
					</div>
				) : (
					<LineView key={`line-${index}`} line={block.line} />
				),
			)}
		</div>
	);
}

function LineView({ line }: { readonly line: Line }): ReactElement | null {
	if (line.kind === "user") return <UserMessage text={line.text} />;
	if (line.kind === "assistant") {
		return line.text.length === 0 ? null : <MarkdownView text={line.text} streaming={line.open} />;
	}
	if (line.kind === "thinking") {
		return <ThinkingBlock text={line.text} streaming={line.open} />;
	}
	if (line.kind === "notice") {
		return (
			<div
				className={cn(
					"flex items-start gap-2 text-ui-sm",
					line.tone === "error" ? "text-destructive" : "text-foreground-subtle",
				)}
			>
				<Info className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 break-words">{line.text}</span>
			</div>
		);
	}
	return null;
}
