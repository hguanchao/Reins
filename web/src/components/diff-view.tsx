import type { ReactElement } from "react";

import { cn } from "./ui/cn.ts";

/** 统一 diff 的着色；+/- 行用专用色，hunk 头弱化。 */
export function DiffView({ diff, className }: { readonly diff: string; readonly className?: string }): ReactElement {
	return (
		<pre className={cn("font-mono text-ui-sm leading-5", className)}>
			{diff.split("\n").map((text, index) => {
				const added = text.startsWith("+") && !text.startsWith("+++");
				const removed = text.startsWith("-") && !text.startsWith("---");
				const hunk = text.startsWith("@@");
				return (
					<div
						key={index}
						className={cn(
							"whitespace-pre-wrap break-words px-1",
							added && "bg-diff-added/10 text-diff-added",
							removed && "bg-diff-removed/10 text-diff-removed",
							hunk && "text-foreground-subtlest",
							!added && !removed && !hunk && "text-foreground-subtle",
						)}
					>
						{text.length === 0 ? " " : text}
					</div>
				);
			})}
		</pre>
	);
}
