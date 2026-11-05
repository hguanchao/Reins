import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../components/ui/cn.ts";

/** 设置页的通用骨架：页头、卡片、设置行与分段选择。 */
export function SettingsHeader({
	title,
	description,
	action,
}: {
	readonly title: string;
	readonly description: string;
	readonly action?: ReactNode;
}): ReactElement {
	return (
		<div className="flex flex-wrap items-start justify-between gap-4">
			<div className="min-w-0">
				<h1 className="m-0 text-[28px] leading-9 font-semibold tracking-[-0.01em]">{title}</h1>
				<p className="mt-2 mb-0 max-w-[620px] text-[13px] leading-5 text-foreground-subtle">
					{description}
				</p>
			</div>
			{action === undefined ? null : <div className="flex shrink-0 items-center gap-2">{action}</div>}
		</div>
	);
}

export function SettingsCard({
	children,
	className,
}: {
	readonly children: ReactNode;
	readonly className?: string;
}): ReactElement {
	return (
		<div
			className={cn(
				"flex flex-col rounded-[16px] border-[0.5px] border-border bg-card",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function SettingRow({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b-[0.5px] border-border px-4 py-3.5 last:border-b-0">
			<div className="flex min-w-0 flex-1 basis-[280px] flex-col gap-0.5">
				<span className="text-[13px] leading-5">{title}</span>
				<span className="text-[12px] leading-[18px] text-foreground-subtlest">{description}</span>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

export function ChoiceGroup<T extends string>({
	options,
	selected,
	onSelect,
}: {
	readonly options: readonly { readonly key: T; readonly label: string }[];
	readonly selected: T;
	onSelect(key: T): void;
}): ReactElement {
	return (
		<div className="flex items-center gap-0.5 rounded-lg bg-surface p-0.5">
			{options.map((option) => (
				<button
					key={option.key}
					type="button"
					onClick={() => onSelect(option.key)}
					aria-pressed={option.key === selected}
					className={cn(
						"h-7 rounded-md px-2.5 text-[12px] leading-[18px] transition-colors",
						option.key === selected
							? "bg-card text-foreground shadow-[0_0_0_0.5px_var(--border)] dark:bg-surface-strong"
							: "text-foreground-subtle hover:text-foreground",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function Badge({
	children,
	tone = "neutral",
}: {
	readonly children: ReactNode;
	readonly tone?: "neutral" | "success" | "muted";
}): ReactElement {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-full px-2 text-[11px] leading-4",
				tone === "success"
					? "bg-success-surface text-success-surface-foreground"
					: tone === "muted"
						? "bg-surface text-foreground-subtlest"
						: "bg-surface text-foreground-subtle",
			)}
		>
			{children}
		</span>
	);
}

export function EmptyState({
	icon: Icon,
	title,
	description,
}: {
	readonly icon: LucideIcon;
	readonly title: string;
	readonly description: string;
}): ReactElement {
	return (
		<div className="flex flex-col items-center gap-2 rounded-[16px] border-[0.5px] border-border bg-card px-6 py-16 text-center">
			<Icon className="size-8 text-foreground-subtlest" />
			<div className="mt-1 text-[14px] leading-[22px] font-medium">{title}</div>
			<p className="m-0 max-w-[420px] text-[12px] leading-[18px] text-foreground-subtlest">
				{description}
			</p>
		</div>
	);
}
