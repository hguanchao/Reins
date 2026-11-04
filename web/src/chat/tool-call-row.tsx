import { ChevronRight, CircleAlert } from "lucide-react";
import { useState, type ReactElement } from "react";

import { DiffView } from "../components/diff-view.tsx";
import { formatDuration } from "../lib/format.ts";
import { cn } from "../components/ui/cn.ts";
import type { ToolLine } from "../transcript/lines.ts";
import { detailText, diffOf, diffStats, toolIcon, toolLabel, toolPrimary } from "./tool-meta.ts";

/** 工具调用行：24px 摘要，展开后看 diff 或输出。 */
export function ToolCallRow({ line }: { readonly line: ToolLine }): ReactElement {
	const [open, setOpen] = useState(false);
	const Icon = toolIcon(line.name);
	const primary = toolPrimary(line.name, line.args);
	const diff = diffOf(line.details);
	const stats = diffStats(diff);
	const body = line.content ?? line.detail ?? detailText(line.details);
	const hasBody = diff !== undefined || body.length > 0;

	return (
		<div className="group/tool flex min-w-0 flex-col">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				disabled={!hasBody}
				aria-expanded={open}
				className={cn(
					"flex h-6 min-w-0 items-center text-left text-[13px] leading-[24px] text-foreground-subtlest transition-colors",
					hasBody ? "cursor-pointer hover:text-foreground-subtle" : "cursor-default",
				)}
			>
				<span className="flex size-4 shrink-0 items-center justify-center">
					<Icon className="size-3.5" />
				</span>
				<span className={cn("ml-1.5 shrink-0 font-normal", line.running && "animate-gradient-text")}>
					{toolLabel(line.name)}
				</span>
				<span className="mx-2 size-0.5 shrink-0 rounded-full bg-foreground-subtlest" />
				<span className={cn("min-w-0 flex-1 truncate", line.isError && "text-destructive")}>
					{line.isError ? (line.summary ?? primary ?? "执行失败") : (primary ?? "")}
				</span>
				{stats.added === 0 && stats.removed === 0 ? null : (
					<span className="ml-2.5 shrink-0 font-mono text-[11px] leading-4 tabular-nums">
						<span className="text-success">+{stats.added}</span>{" "}
						<span className="text-destructive">-{stats.removed}</span>
					</span>
				)}
				{line.durationMs === undefined ? null : (
					<span className="ml-2.5 shrink-0 font-mono text-[11px] leading-4 tabular-nums text-foreground-subtlest">
						{formatDuration(line.durationMs)}
					</span>
				)}
				{line.isError ? <CircleAlert className="ml-2 size-3.5 shrink-0 text-destructive" /> : null}
				{hasBody ? (
					<ChevronRight
						className={cn(
							"ml-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover/tool:opacity-100",
							open && "rotate-90 opacity-100",
						)}
					/>
				) : null}
			</button>

			{open ? (
				<div className="mb-1 ml-1 mt-1 max-h-[260px] overflow-auto rounded-lg border-[0.5px] border-border bg-code-block px-4 py-3">
					{line.isError && line.summary !== undefined ? (
						<div className="mb-2 text-[12px] leading-[18px] text-destructive">{line.summary}</div>
					) : null}
					{diff === undefined ? (
						<pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-foreground-subtle">
							{body}
						</pre>
					) : (
						<DiffView diff={diff} />
					)}
				</div>
			) : null}
		</div>
	);
}
