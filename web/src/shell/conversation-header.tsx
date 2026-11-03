import { ArrowLeft, ArrowRight, PanelRight, PanelRightClose } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";

export type ConversationView = "chat" | "trajectory";

export interface ConversationHeaderProps {
	readonly blank: boolean;
	readonly workspace: string;
	readonly title: string;
	readonly view: ConversationView;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly rightbarOpen: boolean;
	onView(view: ConversationView): void;
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

/** 会话头：面包屑标题、视图页签与右侧工具区；空白会话只留工具区。 */
export function ConversationHeader(props: ConversationHeaderProps): ReactElement {
	const utilities = (
		<div className="flex shrink-0 items-center gap-1">
			<UtilityButton label="后退" disabled={!props.canGoBack} onClick={props.onBack}>
				<ArrowLeft className="size-4" />
			</UtilityButton>
			<UtilityButton label="前进" disabled={!props.canGoForward} onClick={props.onForward}>
				<ArrowRight className="size-4" />
			</UtilityButton>
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
		<header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] border-b-[0.5px] border-border px-7 pt-2.5">
			<div className="flex min-h-[30px] min-w-0 flex-1 items-center gap-2.5">
				<div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
					<span className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-md px-2 py-1 text-[14px] leading-5 text-foreground-subtlest">
						{props.workspace}
					</span>
					<span className="text-[14px] leading-5 text-foreground-subtlest">/</span>
					<span className="inline-flex max-w-[260px] truncate px-1 text-[14px] leading-5 font-medium text-foreground">
						{props.title}
					</span>
				</div>
			</div>
			{utilities}

			<div className="col-span-2 mt-2.5 flex min-h-[25px] items-start">
				<div className="flex min-w-0 flex-wrap gap-8">
					<TabButton active={props.view === "chat"} label="对话" onClick={() => props.onView("chat")} />
					<TabButton
						active={props.view === "trajectory"}
						label="轨迹"
						onClick={() => props.onView("trajectory")}
					/>
				</div>
			</div>
		</header>
	);
}

function TabButton({
	active,
	label,
	onClick,
}: {
	readonly active: boolean;
	readonly label: string;
	onClick(): void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"relative min-h-[35px] -mt-2.5 px-2.5 pt-2.5 pb-[9px] text-[13px] leading-4 font-medium transition-colors",
				active ? "text-(--business-blue)" : "text-foreground-subtlest hover:text-foreground-subtle",
			)}
		>
			{label}
			<span
				className={cn(
					"absolute -right-2.5 -bottom-px -left-2.5 h-0.5 rounded-full",
					active ? "bg-(--business-blue)" : "bg-transparent",
				)}
			/>
		</button>
	);
}
