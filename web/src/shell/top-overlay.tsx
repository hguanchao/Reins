import { ArrowLeft, ArrowRight, MessageCirclePlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";

function OverlayButton({
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
				"flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-subtle transition-colors",
				disabled ? "cursor-default opacity-40" : "hover:bg-surface-hover hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

/**
 * 左上角浮动工具条。
 *
 * 外层 pointer-events-none 只开一条交互区,悬停在工具条之外的标题区仍可拖动窗口。
 * 首个按钮是品牌徽章:平时显示 R 标,悬停交叉淡入成侧栏开关——既当 logo 又当开关。
 */
export function TopOverlay({
	sidebarCollapsed,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
	onToggleSidebar,
	onNewTask,
}: {
	readonly sidebarCollapsed: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	onBack(): void;
	onForward(): void;
	onToggleSidebar(): void;
	onNewTask(): void;
}): ReactElement {
	const ToggleIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;

	return (
		<div className="pointer-events-none absolute left-0 top-0 z-20 h-14">
			<div className="no-drag pointer-events-auto flex h-12 items-center gap-1 pl-3 pt-1">
				<button
					type="button"
					aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
					title={sidebarCollapsed ? "展开侧栏 (Ctrl B)" : "收起侧栏 (Ctrl B)"}
					onClick={onToggleSidebar}
					className="group relative size-7 overflow-hidden rounded-lg text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
				>
					<span
						aria-hidden="true"
						className="flex size-full items-center justify-center font-serif text-ui-lg font-semibold leading-none transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
					>
						R
					</span>
					<ToggleIcon className="absolute inset-0 m-auto size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
				</button>
				<OverlayButton label="后退" disabled={!canGoBack} onClick={onBack}>
					<ArrowLeft className="size-4" />
				</OverlayButton>
				<OverlayButton label="前进" disabled={!canGoForward} onClick={onForward}>
					<ArrowRight className="size-4" />
				</OverlayButton>
				{sidebarCollapsed ? (
					<OverlayButton label="新建任务 (Ctrl N)" onClick={onNewTask}>
						<MessageCirclePlus className="size-4" />
					</OverlayButton>
				) : null}
			</div>
		</div>
	);
}
