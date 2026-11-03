import { Brain, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";

/** 思考块：默认收起，流式期间自动展开，结束后可以手动折叠。 */
export function ThinkingBlock({
	text,
	streaming,
}: {
	readonly text: string;
	readonly streaming: boolean;
}): ReactElement {
	const [open, setOpen] = useState(streaming);

	useEffect(() => {
		if (streaming) setOpen(true);
	}, [streaming]);

	return (
		<div className="text-ui-base">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="inline-flex items-center gap-2 text-foreground-subtle transition-colors hover:text-foreground"
				aria-expanded={open}
			>
				<Brain className="size-4 shrink-0" />
				<span className={streaming ? "animate-gradient-text font-medium" : "font-medium"}>
					{streaming ? "思考中" : "已思考"}
				</span>
				<ChevronRight
					className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
				/>
			</button>
			{open ? (
				<div className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words pl-6 text-ui-base leading-[1.75] tracking-wide text-foreground-subtle">
					{text}
				</div>
			) : null}
		</div>
	);
}
