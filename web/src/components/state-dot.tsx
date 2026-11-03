import type { ReactElement } from "react";

import { cn } from "./ui/cn.ts";

export type StateDotState = "done" | "warning" | "ongoing" | "error" | "idle";

const COLORS: Record<Exclude<StateDotState, "ongoing">, string> = {
	done: "text-success",
	warning: "text-warning",
	error: "text-destructive",
	idle: "text-foreground-subtlest",
};

/** 会话/连接状态点；运行中是带缺口的旋转环，其余是 6px 实心点。 */
export function StateDot({
	state,
	className,
}: {
	readonly state: StateDotState;
	readonly className?: string;
}): ReactElement {
	if (state === "ongoing") {
		return (
			<span className={cn("inline-flex size-2.5 shrink-0 items-center justify-center text-foreground-subtlest", className)}>
				<svg viewBox="0 0 10 10" className="size-2.5 animate-state-ring" aria-hidden="true">
					<circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.25" opacity="0.25" />
					<circle
						cx="5"
						cy="5"
						r="3.75"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.25"
						strokeLinecap="round"
						strokeDasharray="7 20"
					/>
				</svg>
			</span>
		);
	}
	return (
		<span className={cn("inline-flex size-2.5 shrink-0 items-center justify-center", COLORS[state], className)}>
			<span className="size-1.5 rounded-full bg-current" />
		</span>
	);
}
