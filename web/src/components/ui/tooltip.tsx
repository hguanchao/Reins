import { useState, type ReactElement, type ReactNode } from "react";

import { cn } from "./cn.ts";

/** 轻量提示；指针悬停或键盘聚焦时出现，不拦截鼠标。 */
export function Tooltip({
	label,
	side = "bottom",
	children,
	className,
}: {
	readonly label: ReactNode;
	readonly side?: "top" | "bottom";
	readonly children: ReactNode;
	readonly className?: string;
}): ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<span
			className={cn("relative inline-flex", className)}
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			onFocus={() => setOpen(true)}
			onBlur={() => setOpen(false)}
		>
			{children}
			{open ? (
				<span
					role="tooltip"
					className={cn(
						"pointer-events-none absolute left-1/2 z-[70] w-max max-w-xs -translate-x-1/2",
						"rounded-lg border border-border bg-tooltip px-3 py-1.5 text-ui-sm text-tooltip-foreground shadow-md",
						side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
					)}
				>
					{label}
				</span>
			) : null}
		</span>
	);
}
