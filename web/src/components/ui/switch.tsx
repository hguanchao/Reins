import type { ReactElement } from "react";

import { cn } from "./cn.ts";

/** 开关；只表达布尔状态，具体语义由调用方的 label 说明。 */
export function Switch({
	checked,
	onCheckedChange,
	label,
	disabled,
}: {
	readonly checked: boolean;
	onCheckedChange(checked: boolean): void;
	readonly label: string;
	readonly disabled?: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
				checked ? "bg-primary" : "bg-secondary",
				disabled && "pointer-events-none opacity-50",
			)}
		>
			<span
				className={cn(
					"size-4 rounded-full bg-background shadow-xs transition-transform",
					checked ? "translate-x-[18px]" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}
