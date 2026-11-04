import { ArrowLeft, ArrowRight, PanelRight, PanelRightClose } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";

export interface ConversationHeaderProps {
	readonly blank: boolean;
	readonly workspace: string;
	readonly title: string;
	/** 桌面壳的后退/前进安家在标题栏;浏览器没有标题栏,帧头继续承载 */
	readonly showNavigation: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly rightbarOpen: boolean;
	onBack(): void;
	onForward(): void;
	onToggleRightbar(): void;
}

function UtilityButton({
	label,
	disabled,
	onClick,
	children,
}: {
	readonly label: string;
	readonly disabled?: boolean;
	onClick(): void;
	readonly children: ReactElement;
}): ReactElement {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors",
				disabled ? "cursor-default opacity-40" : "hover:bg-surface-hover hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

/** 会话头：面包屑标题与右侧工具区；空白会话只留工具区。 */
export function ConversationHeader(props: ConversationHeaderProps): ReactElement {
	const utilities = (
		<div className="flex shrink-0 items-center gap-1">
			{props.showNavigation ? (
				<>
					<UtilityButton label="后退" disabled={!props.canGoBack} onClick={props.onBack}>
						<ArrowLeft className="size-4" />
					</UtilityButton>
					<UtilityButton label="前进" disabled={!props.canGoForward} onClick={props.onForward}>
						<ArrowRight className="size-4" />
					</UtilityButton>
				</>
			) : null}
			<UtilityButton
				label={props.rightbarOpen ? "关闭面板" : "打开面板"}
				onClick={props.onToggleRightbar}
			>
				{props.rightbarOpen ? <PanelRightClose className="size-4" /> : <PanelRight className="size-4" />}
			</UtilityButton>
		</div>
	);

	if (props.blank) {
		return (
			<header className="relative flex h-[30px] shrink-0 items-center justify-end px-7">
				{utilities}
			</header>
		);
	}

	return (
		<header className="flex h-12 shrink-0 items-center gap-4 border-b-[0.5px] border-border px-7">
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
				<span className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-md px-2 py-1 text-[14px] leading-5 text-foreground-subtlest">
					{props.workspace}
				</span>
				<span className="text-[14px] leading-5 text-foreground-subtlest">/</span>
				<span className="inline-flex max-w-[260px] truncate px-1 text-[14px] leading-5 font-medium text-foreground">
					{props.title}
				</span>
			</div>
			{utilities}
		</header>
	);
}
