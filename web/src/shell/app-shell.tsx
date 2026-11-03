import type { ReactElement, ReactNode } from "react";

import { cn } from "../components/ui/cn.ts";

/**
 * 帧式主体布局。
 *
 * 窗口底是 background-win-alt 灰底,侧栏、会话区、右面板各是一块独立圆角帧,
 * 帧间由 1px 分隔条占位、拖拽把手叠在上面。外沿 pr-1 pb-1 + 顶部 h-1 拖拽条
 * 让每一帧都不贴住窗口边缘,这是整个窗口观感的基础。
 */
export function AppShell({
	sidebar,
	resizeHandle,
	children,
	sidePane,
}: {
	readonly sidebar: ReactNode;
	/** 侧栏与主区之间的分隔拖拽把手,由调用方提供拖拽逻辑 */
	readonly resizeHandle?: ReactNode;
	readonly children: ReactNode;
	readonly sidePane?: ReactNode;
}): ReactElement {
	return (
		<div className="flex min-h-0 w-full flex-1 overflow-hidden">
			{sidebar}
			{resizeHandle}
			<div
				className={cn(
					"flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden",
					// 右面板收起时,主区自己补上外沿留白;打开时由面板帧的右边距承担
					sidePane === undefined && "pr-1 pb-1",
					sidePane !== undefined && "pb-1",
				)}
			>
				{children}
			</div>
			{sidePane}
		</div>
	);
}
