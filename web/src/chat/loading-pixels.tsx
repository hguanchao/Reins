import type { ReactElement } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import { cn } from "../components/ui/cn.ts";

/** 运行中状态：小号品牌标识 + 流光文字，替代传统的三点加载。 */
export function LoadingPixels({
	label = "正在思考",
	elapsed,
	className,
}: {
	readonly label?: string;
	readonly elapsed?: string;
	readonly className?: string;
}): ReactElement {
	return (
		<div
			className={cn("inline-flex h-7 items-center gap-1.5 text-[13px] leading-5", className)}
			role="status"
			aria-label={label}
		>
			<BrandMark size={14} />
			<span className="animate-gradient-text font-medium">{label} ···</span>
			{elapsed === undefined ? null : (
				<span className="font-mono text-[11px] tabular-nums text-foreground-subtlest">{elapsed}</span>
			)}
		</div>
	);
}
