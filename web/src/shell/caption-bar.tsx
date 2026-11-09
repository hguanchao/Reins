import { ArrowLeft, ArrowRight, Copy, Folder, Minus, PanelLeft, Search, Square, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { desktopBridge } from "../platform.ts";

/**
 * 窗控区。
 *
 * 桌面壳（Windows / Linux）由页面自绘三枚钮，动作递给主进程；macOS 保留系统红绿灯，
 * 这里只留空位；浏览器预览照设计稿画两枚示意方块。让位方向由 index.html 落下的
 * data-titlebar-platform 决定。
 */
export function WindowControls(): ReactElement {
	const bridge = desktopBridge();
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		if (bridge === undefined) return;
		// 首屏问一次、后续靠主进程推送；卸载后不再把异步结果写回已销毁的组件
		let alive = true;
		void bridge.isWindowMaximized().then((value) => {
			if (alive) setMaximized(value);
		}).catch(() => {});
		const unsubscribe = bridge.onWindowStateChanged(setMaximized);
		return () => {
			alive = false;
			unsubscribe();
		};
	}, [bridge]);

	if (bridge === undefined) {
		return (
			<div className="win-slot" aria-hidden="true">
				<i />
				<i />
			</div>
		);
	}
	// macOS 的交通灯在左侧由系统绘制，右侧不补第二份窗控
	if (document.documentElement.dataset.titlebarPlatform === "mac") {
		return <div className="win-slot" aria-hidden="true" />;
	}

	return (
		<div className="win-slot custom" aria-label="窗口控制">
			<button
				type="button"
				className="wbtn"
				aria-label="最小化"
				title="最小化"
				onClick={() => bridge.controlWindow("minimize")}
			>
				<Minus className="ic ic-12" />
			</button>
			<button
				type="button"
				className="wbtn"
				aria-label={maximized ? "还原" : "最大化"}
				title={maximized ? "还原" : "最大化"}
				onClick={() => bridge.controlWindow("toggle-maximize")}
			>
				{maximized ? <Copy className="ic ic-12" /> : <Square className="ic ic-12" />}
			</button>
			<button
				type="button"
				className="wbtn wclose"
				aria-label="关闭窗口"
				title="关闭窗口"
				onClick={() => bridge.controlWindow("close")}
			>
				<X className="ic ic-12" />
			</button>
		</div>
	);
}

/**
 * 窗口标题栏。
 *
 * 34px 高：左侧四个图标（栏开关、搜索、后退、前进），中间面包屑，右侧是窗控区。整条是
 * 拖拽区，按钮各自 no-drag；窗控三枚钮由页面自绘，macOS 的红绿灯仍归系统。
 */
export function CaptionBar({
	sidebarCollapsed,
	workspace,
	title,
	onToggleSidebar,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
}: {
	readonly sidebarCollapsed: boolean;
	readonly workspace: string;
	readonly title: string;
	onToggleSidebar(): void;
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
			<button type="button" className="cbtn no-drag" aria-label="搜索任务（即将支持）" title="搜索任务（即将支持）" disabled>
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
					<ArrowLeft className="ic" />
				</button>
				<button
					type="button"
					className="cbtn no-drag"
					aria-label="前进"
					title="前进"
					disabled={!canGoForward}
					onClick={onForward}
				>
					<ArrowRight className="ic" />
			</button>

			<div className="crumb">
				{workspace.length === 0 ? null : (
					<>
						<Folder className="ic ic-12" />
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
