import { ChevronRight, CircleAlert, Loader2 } from "lucide-react";
import { useState, type ReactElement } from "react";

import { DiffView } from "../components/diff-view.tsx";
import { cn } from "../components/ui/cn.ts";
import type { ToolLine } from "../transcript/lines.ts";
import { detailText, diffOf, diffStats, toolIcon, toolLabel, toolPrimary } from "./tool-meta.ts";

/** 工具调用：一行摘要，展开看输出或 diff。 */
export function ToolCallRow({ line }: { readonly line: ToolLine }): ReactElement {
	const [open, setOpen] = useState(false);
	const Icon = toolIcon(line.name);
	const primary = toolPrimary(line.name, line.args);
	const diff = diffOf(line.details);
	const stats = diffStats(diff);
	const hasBody = diff !== undefined || line.content !== undefined || line.detail.length > 0 || line.details !== undefined;

	return (
		<div className="group/tool min-w-0">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				disabled={!hasBody}
				aria-expanded={open}
				className="flex max-w-full items-center gap-2 self-start text-left text-ui-base"
			>
				<Icon className="size-4 shrink-0 text-foreground-subtlest" />
				<span
					className={cn(
						"shrink-0 font-medium",
						line.running ? "animate-gradient-text" : "text-foreground-subtlest",
					)}
				>
					{toolLabel(line.name)}
				</span>
				{primary === undefined ? null : (
					<span className="min-w-0 truncate text-foreground-subtle">{primary}</span>
				)}
				{stats.added === 0 && stats.removed === 0 ? null : (
					<span className="shrink-0 font-mono text-ui-sm tabular-nums">
						<span className="text-diff-added">+{stats.added}</span>{" "}
						<span className="text-diff-removed">-{stats.removed}</span>
					</span>
				)}
				{line.durationMs === undefined ? null : (
					<span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
						{formatDuration(line.durationMs)}
					</span>
				)}
				{line.running ? (
					<Loader2 className="size-4 shrink-0 animate-spin text-foreground-subtlest" />
				) : line.isError ? (
					<CircleAlert className="size-4 shrink-0 text-destructive" />
				) : null}
				{hasBody ? (
					<ChevronRight
						className={cn(
							"size-4 shrink-0 text-foreground-subtlest opacity-0 transition-transform group-hover/tool:opacity-100",
							open && "rotate-90 opacity-100",
						)}
					/>
				) : null}
			</button>

			{line.running ? (
				<div className="ml-6 mt-1 h-1 w-16 overflow-hidden rounded-full bg-surface-hover">
					<div className="h-full w-1/2 rounded-full bg-brand animate-sweep" />
				</div>
			) : null}

			{open ? (
				<div className="ml-6 mt-2 max-h-60 overflow-auto rounded-xl border border-border bg-surface px-3 py-2">
					{line.isError && line.summary !== undefined ? (
						<div className="mb-2 text-ui-sm text-destructive">{line.summary}</div>
					) : null}
					{diff === undefined ? (
						<pre className="whitespace-pre-wrap break-words font-mono text-ui-sm leading-5 text-foreground-subtle">
							{line.content ?? line.detail ?? detailText(line.details)}
						</pre>
					) : (
						<DiffView diff={diff} />
					)}
				</div>
			) : null}
		</div>
	);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}
