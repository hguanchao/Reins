import { Brain, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";

function firstLine(text: string): string {
	const normalized = text.replaceAll("\r\n", "\n").trim();
	const newline = normalized.indexOf("\n");
	return newline === -1 ? normalized : normalized.slice(0, newline);
}

/** 思考行：24px 摘要，展开后阅读完整推理。 */
export function ThinkingBlock({
	text,
	streaming,
}: {
	readonly text: string;
	readonly streaming: boolean;
}): ReactElement {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (streaming) setOpen(false);
	}, [streaming]);

	const summary = firstLine(text);

	return (
		<div className="flex flex-col">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="group/think flex h-6 min-w-0 items-center text-left text-[13px] leading-[24px] text-foreground-subtlest transition-colors hover:text-foreground-subtle"
			>
				<span className="flex size-4 shrink-0 items-center justify-center">
					<Brain className="size-3.5" />
				</span>
				<span
					className={cn(
						"ml-1.5 shrink-0 font-normal",
						streaming && "animate-gradient-text",
					)}
				>
					{streaming ? "思考中" : "已思考"}
				</span>
				{summary.length === 0 ? null : (
					<>
						<span className="mx-2 size-0.5 shrink-0 rounded-full bg-foreground-subtlest" />
						<span className="min-w-0 flex-1 truncate">{summary}</span>
					</>
				)}
				<ChevronRight
					className={cn(
						"ml-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover/think:opacity-100",
						open && "rotate-90 opacity-100",
					)}
				/>
			</button>
			{open ? (
				<div
					className="max-h-[360px] overflow-y-auto whitespace-pre-wrap break-words pb-1 pl-[22px] pt-1 text-[13px] leading-6 tracking-wide text-foreground-subtlest"
				>
					{text}
				</div>
			) : null}
		</div>
	);
}
