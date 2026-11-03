import { MessageSquarePlus, PanelLeft } from "lucide-react";
import type { ReactElement } from "react";

/**
 * 窗口标题栏。
 *
 * 桌面端由 Electron 原生覆盖层承载最小化/最大化/关闭；这里只画拖拽区与左侧控制。
 * 侧栏收起时「新会话」也移到标题栏，避免主区左上角多出一条工具带。
 */
export function CaptionBar({
	sidebarCollapsed,
	onToggleSidebar,
	onNewSession,
}: {
	readonly sidebarCollapsed: boolean;
	onToggleSidebar(): void;
	onNewSession(): void;
}): ReactElement {
	return (
		<div className="drag-region absolute inset-x-0 top-0 z-30 flex h-(--caption-height) items-center gap-2 bg-sidebar pl-3">
			<button
				type="button"
				aria-label={sidebarCollapsed ? "打开侧边栏" : "收起侧边栏"}
				title={sidebarCollapsed ? "打开侧边栏 (Ctrl B)" : "收起侧边栏 (Ctrl B)"}
				onClick={onToggleSidebar}
				className="no-drag flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
			>
				<PanelLeft className="size-4" />
			</button>
			{sidebarCollapsed ? (
				<button
					type="button"
					aria-label="新建会话"
					title="新建会话 (Ctrl N)"
					onClick={onNewSession}
					className="no-drag flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
				>
					<MessageSquarePlus className="size-4" />
				</button>
			) : null}
		</div>
	);
}
