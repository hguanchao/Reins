import { useEffect } from "react";

import { autoSidebarAction } from "../shell/columns.ts";

/**
 * 窗口宽度变化后的三栏自动收放。
 *
 * 窄窗先让右面板整条让出，再按阈值收起侧栏；拖拽与用户亲手收起的状态不代劳。
 * 这里只做监听与状态更新，列宽求解仍由纯函数负责。
 */

export interface ResponsiveColumnsContext {
	readonly sidebarCollapsed: boolean;
	readonly sidebarWidth: number;
	readonly sideOpen: boolean;
	readonly autoCollapsed: boolean;
	onSidebarCollapsed(value: boolean): void;
	onAutoCollapsed(value: boolean): void;
	onSideOpen(value: boolean): void;
	onSideFullscreen(value: boolean): void;
}

export function useResponsiveColumns(context: ResponsiveColumnsContext): void {
	const {
		sidebarCollapsed,
		sidebarWidth,
		sideOpen,
		autoCollapsed,
		onSidebarCollapsed,
		onAutoCollapsed,
		onSideOpen,
		onSideFullscreen,
	} = context;

	useEffect(() => {
		const onResize = (): void => {
			const action = autoSidebarAction(window.innerWidth, sidebarCollapsed, autoCollapsed);
			if (action === true) {
				onSidebarCollapsed(true);
				onAutoCollapsed(true);
			} else if (action === false) {
				onSidebarCollapsed(false);
				onAutoCollapsed(false);
			}
			const available = window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth);
			if (sideOpen && available < 720) {
				onSideOpen(false);
				onSideFullscreen(false);
			}
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [
		autoCollapsed,
		onAutoCollapsed,
		onSideFullscreen,
		onSideOpen,
		onSidebarCollapsed,
		sidebarCollapsed,
		sidebarWidth,
		sideOpen,
	]);
}
