import { ArrowLeft, ArrowRight, MessageSquarePlus, PanelLeft, Search } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../components/ui/cn.ts";

/**
 * 窗口标题栏。
 *
 * 桌面端由 Electron 原生覆盖层承载最小化/最大化/关闭；这里只画拖拽区与左侧控制。
 * 侧栏收起时「新会话」也移到标题栏，避免主区左上角多出一条工具带；
 * 会话浏览历史的后退/前进同样安家在这里，会话帧头不再重复。
 */
export function CaptionBar({
	sidebarCollapsed,
	onToggleSidebar,
	onNewSession,
	onOpenSearch,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
}: {
	readonly sidebarCollapsed: boolean;
	onToggleSidebar(): void;
	onNewSession(): void;
	/** 打开会话搜索：侧栏收起时先展开侧栏（展开逻辑由应用层处理） */
	onOpenSearch(): void;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	onBack(): void;
	onForward(): void;
}): ReactElement {
	const button = "no-drag flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground";
	const navButton = (label: string, enabled: boolean, onClick: () => void, icon: ReactNode): ReactElement => (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={!enabled}
			onClick={onClick}
			className={cn(button, !enabled && "cursor-default opacity-40 hover:bg-transparent hover:text-foreground-subtle")}
		>
			{icon}
		</button>
	);

	return (
		<div className="drag-region absolute inset-x-0 top-0 z-30 flex h-(--caption-height) items-center gap-2 bg-sidebar pl-3">
			<button
				type="button"
				aria-label={sidebarCollapsed ? "打开侧边栏" : "收起侧边栏"}
				title={sidebarCollapsed ? "打开侧边栏 (Ctrl B)" : "收起侧边栏 (Ctrl B)"}
				onClick={onToggleSidebar}
				className={button}
			>
				<PanelLeft className="size-4" />
			</button>
			{sidebarCollapsed ? (
				<button
					type="button"
					aria-label="新建任务"
					title="新建任务 (Ctrl N)"
					onClick={onNewSession}
					className={button}
				>
					<MessageSquarePlus className="size-4" />
				</button>
			) : null}
			<button
				type="button"
				aria-label="搜索任务"
				title="搜索任务"
				onClick={onOpenSearch}
				className={button}
			>
				<Search className="size-4" />
			</button>
			{navButton("后退", canGoBack, onBack, <ArrowLeft className="size-4" />)}
			{navButton("前进", canGoForward, onForward, <ArrowRight className="size-4" />)}
		</div>
	);
}
