import type { ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";

/** 9 格像素加载：中间静止，外圈按轨道顺序依次点亮。 */
const ORBIT = [0, 1, 2, 5, 8, 7, 6, 3] as const;

export function LoadingPixels({
	label = "思考中",
	elapsed,
	className,
}: {
	readonly label?: string;
	readonly elapsed?: string;
	readonly className?: string;
}): ReactElement {
	return (
		<div className={cn("inline-flex items-center gap-2.5 text-ui-base text-foreground-subtle", className)}>
			<span className="grid size-[13px] shrink-0 grid-cols-3 gap-[1.3px]" aria-hidden="true">
				{Array.from({ length: 9 }, (_, index) => {
					const orbitIndex = ORBIT.indexOf(index as (typeof ORBIT)[number]);
					const center = index === 4;
					return (
						<span
							key={index}
							className={cn("size-full rounded-[1px] bg-current", !center && "animate-pixel")}
							style={
								center
									? { opacity: 0.07 }
									: { animationDelay: `${orbitIndex * 110}ms`, opacity: 0.15 }
							}
						/>
					);
				})}
			</span>
			<span className="animate-shimmer font-medium">{label}</span>
			{elapsed === undefined ? null : (
				<span className="font-mono text-ui-caption tabular-nums text-foreground-subtlest">{elapsed}</span>
			)}
		</div>
	);
}
