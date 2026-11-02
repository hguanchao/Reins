import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

import { cn } from "./cn.ts";

/** 按钮的视觉层级；组件只选层级，不写具体颜色。 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "link";
export type ButtonSize = "xs" | "sm" | "default" | "lg" | "icon-xs" | "icon-sm" | "icon" | "icon-lg";

const VARIANTS: Record<ButtonVariant, string> = {
	primary: "bg-primary text-primary-foreground hover:opacity-90",
	secondary: "bg-secondary text-foreground hover:bg-secondary/80",
	ghost: "text-foreground hover:bg-surface-hover",
	outline: "border border-border bg-transparent text-foreground hover:bg-surface-hover",
	danger: "bg-destructive text-foreground-inverse hover:opacity-90",
	link: "text-icon-blue underline-offset-4 hover:underline",
};

const SIZES: Record<ButtonSize, string> = {
	xs: "h-5 rounded-md px-2 text-ui-sm",
	sm: "h-6 rounded-md px-2.5 text-ui-sm",
	default: "h-7 rounded-lg px-3 text-ui-base",
	lg: "h-8 rounded-lg px-3.5 text-ui-base",
	"icon-xs": "size-5 rounded-md",
	"icon-sm": "size-6 rounded-md",
	icon: "size-7 rounded-lg",
	"icon-lg": "size-8 rounded-lg",
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
		<button
			type="button"
			className={cn(
				"inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors",
				"disabled:pointer-events-none disabled:opacity-50",
				VARIANTS[variant],
				SIZES[size],
				className,
			)}
			{...props}
		>
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
		<Button
			size={size}
			aria-label={label}
			title={label}
			className={cn("text-foreground-subtle hover:text-foreground", className)}
			{...props}
		>
			{children}
		</Button>
	);
}
