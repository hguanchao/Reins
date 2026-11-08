import { ChevronLeft, ChevronRight, Folder, PanelLeft, Search } from "lucide-react";
import type { ReactElement } from "react";

import { hasNativeTitlebar } from "../platform.ts";

/**
 * 窗控区。
 *
 * demo 里是两枚示意方块（最小化 / 最大化），浏览器预览时照原样画出来；桌面壳用系统
 * 原生覆盖层承载窗控，这里只让出位置，不再画第二份。Windows 的窗控在右、macOS 的
 * 红绿灯在左，让位方向由 index.html 落下的 data-titlebar-platform 决定。
 */
export function WindowControls(): ReactElement {
	const native = hasNativeTitlebar();
	return (
		<div className={`win-slot${native ? " native" : ""}`} aria-hidden="true">
			{native ? null : (
				<>
					<i />
					<i />
				</>
			)}
		</div>
	);
}

/**
 * 窗口标题栏。
 *
 * 34px 高：左侧四个图标（栏开关、搜索、后退、前进），中间面包屑，右侧是窗控区。整条是
 * 拖拽区，按钮各自 no-drag。桌面壳用原生覆盖层承载最小化/最大化/关闭，这里只让出位置。
 */
export function CaptionBar({
	sidebarCollapsed,
	workspace,
	title,
	onToggleSidebar,
	onOpenSearch,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
}: {
	readonly sidebarCollapsed: boolean;
	readonly workspace: string;
	readonly title: string;
	onToggleSidebar(): void;
	onOpenSearch(): void;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	onBack(): void;
	onForward(): void;
}): ReactElement {
	return (
		<div className="caption drag-region">
			<button
				type="button"
				className="cbtn no-drag"
				aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
				title={sidebarCollapsed ? "展开侧栏 (Ctrl B)" : "收起侧栏 (Ctrl B)"}
				onClick={onToggleSidebar}
			>
				<PanelLeft className="ic" />
			</button>
			<button type="button" className="cbtn no-drag" aria-label="搜索任务" title="搜索任务" onClick={onOpenSearch}>
				<Search className="ic" />
			</button>
			<button
				type="button"
				className="cbtn no-drag"
				aria-label="后退"
				title="后退"
				disabled={!canGoBack}
				onClick={onBack}
			>
				<ChevronLeft className="ic" />
			</button>
			<button
				type="button"
				className="cbtn no-drag"
				aria-label="前进"
				title="前进"
				disabled={!canGoForward}
				onClick={onForward}
			>
				<ChevronRight className="ic" />
			</button>

			<div className="crumb">
				{workspace.length === 0 ? null : (
					<>
						<Folder className="ic-12" />
						<span>{workspace}</span>
						<span className="sep">/</span>
					</>
				)}
				<span className="now">{title}</span>
			</div>

			<WindowControls />
		</div>
	);
}
