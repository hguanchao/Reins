import { X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../components/ui/cn.ts";

export interface PanelPageTab {
	readonly id: string;
	readonly label: string;
}

/** 全局面板的页头与内容列：与全局面板页共用一套宽度与留白。 */
export function PanelPage({
	title,
	description,
	actions,
	tabs,
	activeTab,
	onTab,
	onClose,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly actions?: ReactNode;
	readonly tabs?: readonly PanelPageTab[];
	readonly activeTab?: string;
	onTab?(id: string): void;
	readonly onClose: () => void;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<div className="flex shrink-0 flex-col items-center px-[clamp(24px,4vw,48px)]">
				<div className="flex w-full max-w-[960px] flex-wrap items-start justify-between gap-4 pt-7">
					<div className="min-w-0">
						<h1 className="m-0 text-[20px] leading-7 font-medium">{title}</h1>
						<p className="mt-1 mb-0 text-[13px] leading-5 text-foreground-subtle">{description}</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{actions}
						<button
							type="button"
							aria-label="返回会话"
							title="返回会话"
							onClick={onClose}
							className="flex size-7 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
						>
							<X className="size-4" />
						</button>
					</div>
				</div>
				{tabs === undefined ? null : (
					<div className="flex w-full max-w-[960px] gap-6 border-b-[0.5px] border-border pt-5">
						{tabs.map((tab) => (
							<button
								key={tab.id}
								type="button"
								onClick={() => onTab?.(tab.id)}
								className={cn(
									"relative -mb-px px-1 pb-2.5 text-[13px] leading-4 font-medium transition-colors",
									tab.id === activeTab
										? "text-(--business-blue)"
										: "text-foreground-subtlest hover:text-foreground-subtle",
								)}
							>
								{tab.label}
								<span
									className={cn(
										"absolute inset-x-0 bottom-0 h-0.5 rounded-full",
										tab.id === activeTab ? "bg-(--business-blue)" : "bg-transparent",
									)}
								/>
							</button>
						))}
					</div>
				)}
			</div>
			<div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-[clamp(24px,4vw,48px)] pb-12 pt-6">
				<div className="flex w-full max-w-[960px] flex-col">{children}</div>
			</div>
		</div>
	);
}
