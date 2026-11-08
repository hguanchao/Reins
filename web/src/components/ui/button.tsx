import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

import { cn } from "./cn.ts";

/**
 * 按钮。
 *
 * 视觉层级只有四种：实心（每屏最多一个主动作）、描边（次动作）、无框（三级动作）、
 * 危险描边（止损）。尺寸 24 / 28 / 34px 对应 11 / 12 / 14px 字。
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
export type ButtonSize = "xs" | "sm" | "default" | "icon-xs" | "icon-sm" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
	primary: "b-solid",
	secondary: "b-line",
	ghost: "b-ghost",
	outline: "b-line",
	danger: "b-danger",
};

const SIZES: Record<ButtonSize, string> = {
	xs: "b-sm",
	sm: "b-sm",
	default: "",
	"icon-xs": "size-6 p-0",
	"icon-sm": "size-7 p-0",
	icon: "size-7 p-0",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	readonly variant?: ButtonVariant;
	readonly size?: ButtonSize;
}

export function Button({
	variant = "ghost",
	size = "default",
	className,
	children,
	...props
}: ButtonProps): ReactElement {
	return (
		<button type="button" className={cn("b shrink-0 select-none", VARIANTS[variant], SIZES[size], className)} {...props}>
			{children}
		</button>
	);
}

/** 方形图标按钮；label 同时作为 aria-label 与原生提示。 */
export function IconButton({
	label,
	className,
	children,
	size = "icon",
	...props
}: Omit<ButtonProps, "children"> & {
	readonly label: string;
	readonly children: ReactNode;
	readonly size?: ButtonSize;
}): ReactElement {
	return (
		<Button size={size} aria-label={label} title={label} className={cn("b-ghost", className)} {...props}>
			{children}
		</Button>
	);
}
