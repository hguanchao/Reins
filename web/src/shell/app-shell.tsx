import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from "react";

import { cn } from "../components/ui/cn.ts";
import { hasNativeTitlebar } from "../platform.ts";
import { CaptionBar } from "./caption-bar.tsx";
import { computeColumns } from "./columns.ts";

interface DragHandleProps {
	readonly side: "sidebar" | "rightbar";
	readonly left: number;
	onStart(): void;
	onDrag(dx: number): void;
	onEnd(): void;
}

/** 8px 无痕命中带：不画可见把手，只负责指针捕获与每帧回报。 */
function DragHandle({ side, left, onStart, onDrag, onEnd }: DragHandleProps): ReactElement {
	const [dragging, setDragging] = useState(false);
	const origin = useRef(0);
	const latest = useRef(0);
	const frame = useRef<number | null>(null);
	const callbacks = useRef({ onStart, onDrag, onEnd });
	callbacks.current = { onStart, onDrag, onEnd };

	const stop = useCallback((): void => {
		if (frame.current !== null) {
			cancelAnimationFrame(frame.current);
			frame.current = null;
		}
		setDragging(false);
		callbacks.current.onEnd();
	}, []);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		origin.current = event.clientX;
		latest.current = event.clientX;
		callbacks.current.onStart();
		setDragging(true);
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={side === "sidebar" ? "调整侧栏宽度" : "调整面板宽度"}
			data-side={side}
			data-dragging={dragging || undefined}
			onPointerDown={onPointerDown}
			onPointerMove={(event) => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
				latest.current = event.clientX;
				if (frame.current !== null) return;
				frame.current = requestAnimationFrame(() => {
					frame.current = null;
					callbacks.current.onDrag(latest.current - origin.current);
				});
			}}
			onPointerUp={(event) => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
				event.currentTarget.releasePointerCapture(event.pointerId);
				callbacks.current.onDrag(event.clientX - origin.current);
				stop();
			}}
			onPointerCancel={stop}
			onLostPointerCapture={stop}
			className="absolute top-0 bottom-0 z-20 w-2 -translate-x-1 cursor-col-resize touch-none"
			style={{ left }}
		/>
	);
}

export interface AppShellProps {
	readonly sidebarWidth: number;
	readonly sidebarCollapsed: boolean;
	readonly rightbarWidth: number;
	readonly rightbarOpen: boolean;
	readonly rightbarFullscreen: boolean;
	readonly sidebar: ReactNode;
	readonly children: ReactNode;
	readonly rightbar?: ReactNode;
	onSidebarWidth(width: number): void;
	onRightbarWidth(width: number): void;
	onToggleSidebar(): void;
	onNewSession(): void;
	onOpenSearch(): void;
	/** 会话浏览历史;标题栏承载后退/前进(仅桌面壳有标题栏) */
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	onBack(): void;
	onForward(): void;
}

/**
 * 三栏帧。
 *
 * 窗口底是侧栏底色，主列是唯一的上浮面：左上 16px 圆角直接落在侧栏底上。
 * 右栏是一条可以收放的轨道，面板本身贴着窗口右边；拖拽带是隐藏的 8px 命中区。
 */
export function AppShell({
	sidebarWidth,
	sidebarCollapsed,
	rightbarWidth,
	rightbarOpen,
	rightbarFullscreen,
	sidebar,
	children,
	rightbar,
	onSidebarWidth,
	onRightbarWidth,
	onToggleSidebar,
	onNewSession,
	onOpenSearch,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
}: AppShellProps): ReactElement {
	const frame = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
	const [dragging, setDragging] = useState(false);
	const [animating, setAnimating] = useState(false);
	const hasCaption = hasNativeTitlebar();

	useLayoutEffect(() => {
		const element = frame.current;
		if (element === null) return;
		let raf: number | null = null;
		const measure = (): void => {
			const width = element.getBoundingClientRect().width;
			if (width > 0) setViewport(width);
		};
		measure();
		const observer = new ResizeObserver(() => {
			if (raf !== null) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				measure();
			});
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			if (raf !== null) cancelAnimationFrame(raf);
		};
	}, []);

	// 过渡只在翻转后的短暂窗口里开启(拖拽与窗口缩放时不动画),但必须用 layout effect:
	// 普通 effect 在绘制之后才跑,过渡属性到场时列宽早已跳变完,动画就时有时无
	useLayoutEffect(() => {
		setAnimating(true);
		const timer = window.setTimeout(() => setAnimating(false), 320);
		return () => window.clearTimeout(timer);
	}, [sidebarCollapsed, rightbarOpen]);

	const cols = computeColumns(viewport, sidebarCollapsed ? 0 : sidebarWidth, rightbarOpen ? rightbarWidth : 0);
	const fullscreen = rightbarOpen && rightbarFullscreen && cols.rightbar > 0;
	const template = fullscreen
		? `${cols.sidebar}px minmax(0, 0px) ${Math.max(0, viewport - cols.sidebar)}px`
		: `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px`;
	const sidebarBase = useRef(0);
	const rightbarBase = useRef(0);

	return (
		<div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-sidebar">
			{hasCaption ? (
				<CaptionBar
					sidebarCollapsed={sidebarCollapsed}
					onToggleSidebar={onToggleSidebar}
					onNewSession={onNewSession}
					onOpenSearch={onOpenSearch}
					canGoBack={canGoBack}
					canGoForward={canGoForward}
					onBack={onBack}
					onForward={onForward}
				/>
			) : null}
			<div
				ref={frame}
				className="relative grid min-h-0 flex-1 overflow-hidden"
				style={{
					paddingTop: "var(--caption-height)",
					gridTemplateColumns: template,
					transition: animating && !dragging ? "grid-template-columns 300ms cubic-bezier(0.4, 0, 0.2, 1)" : "none",
				}}
				data-sidebar-collapsed={sidebarCollapsed || undefined}
				data-rightbar-collapsed={cols.rightbar === 0 || undefined}
				data-rightbar-fullscreen={fullscreen || undefined}
				data-dragging={dragging || undefined}
			>
				<div className="min-w-0 overflow-hidden">
					{sidebarCollapsed ? null : sidebar}
				</div>
				<div className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-tl-[16px] bg-background")}>
					{children}
				</div>
				<div className="min-w-0 overflow-visible">
					{cols.rightbar > 0 ? rightbar : null}
				</div>

				{sidebarCollapsed ? null : (
					<DragHandle
						side="sidebar"
						left={cols.sidebar}
						onStart={() => {
							sidebarBase.current = cols.sidebar;
							setDragging(true);
						}}
						onDrag={(dx) => onSidebarWidth(sidebarBase.current + dx)}
						onEnd={() => setDragging(false)}
					/>
				)}
				{cols.rightbar > 0 && !fullscreen ? (
					<DragHandle
						side="rightbar"
						left={cols.sidebar + cols.center}
						onStart={() => {
							rightbarBase.current = cols.rightbar;
							setDragging(true);
						}}
						onDrag={(dx) => onRightbarWidth(rightbarBase.current - dx)}
						onEnd={() => setDragging(false)}
					/>
				) : null}
			</div>
		</div>
	);
}
