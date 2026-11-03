import type { ReactElement, ReactNode } from "react";

import { cn } from "../components/ui/cn.ts";

/**
 * 会话帧头部。
 *
 * 整条是窗口拖拽区,可交互元素逐个标 no-drag;草稿态没有会话标题,下边框隐藏,
 * 让会话帧的上缘保持干净。窗控在最右端,与头部同高。
 */
export function WorkspaceHeader({
	variant = "task",
	/** 侧栏收起时,左上角浮动工具条盖在头部上,标题要给工具条让出左侧空间 */
	overlayLeading = false,
	leading,
	actions,
}: {
	/** draft = 还没有会话(新建任务态),task = 已有会话在展示 */
	readonly variant?: "draft" | "task";
	readonly overlayLeading?: boolean;
	readonly leading?: ReactNode;
	readonly actions?: ReactNode;
}): ReactElement {
	return (
		<header
			className={cn(
				"drag-region relative flex h-12 w-full shrink-0 items-center justify-between gap-2 overflow-hidden px-2 transition-[padding] duration-300",
				variant === "draft" ? "border-b border-transparent" : "border-b border-border/50",
				overlayLeading && "pl-40",
			)}
		>
			<div className="no-drag flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
				{leading}
			</div>
			{actions === undefined ? null : (
				<div className="no-drag flex shrink-0 items-center gap-1">{actions}</div>
			)}
		</header>
	);
}
