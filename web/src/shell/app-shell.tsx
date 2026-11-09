import {
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent,
	type ReactElement,
	type ReactNode,
} from "react";

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
	readonly workspace: string;
	readonly title: string;
	readonly sidebar: ReactNode;
	readonly children: ReactNode;
	readonly rightbar?: ReactNode;
	/** 被设置页等覆盖时移出焦点与可访问性树，避免 Tab 落回后台界面 */
	readonly inactive?: boolean;
	onSidebarWidth(width: number): void;
	onRightbarWidth(width: number): void;
	onToggleSidebar(): void;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	onBack(): void;
	onForward(): void;
}

/**
 * 三栏帧。
 *
 * 三栏齐平，不浮起：主列不再有圆角与投影，改用 1px 细线分区。拖拽带是隐藏的 8px 命中区；
 * 面板全屏时主列折叠为 0，侧栏宽度仍受上下限约束。
 */
export function AppShell({
	sidebarWidth,
	sidebarCollapsed,
	rightbarWidth,
	rightbarOpen,
	rightbarFullscreen,
	workspace,
	title,
	sidebar,
	children,
	rightbar,
	inactive,
	onSidebarWidth,
	onRightbarWidth,
	onToggleSidebar,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
}: AppShellProps): ReactElement {
	const frame = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
	const [dragging, setDragging] = useState(false);

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

	const cols = computeColumns(viewport, sidebarCollapsed ? 0 : sidebarWidth, rightbarOpen ? rightbarWidth : 0);
	const fullscreen = rightbarOpen && rightbarFullscreen && cols.rightbar > 0;
	const template = fullscreen
		? `${cols.sidebar}px minmax(0, 0px) ${Math.max(0, viewport - cols.sidebar)}px`
		: `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px`;
	const sidebarBase = useRef(0);
	const rightbarBase = useRef(0);

	return (
		<div inert={inactive || undefined} aria-hidden={inactive || undefined} className="app">
			<CaptionBar
				sidebarCollapsed={sidebarCollapsed}
				workspace={workspace}
				title={title}
				onToggleSidebar={onToggleSidebar}
				canGoBack={canGoBack}
				canGoForward={canGoForward}
				onBack={onBack}
				onForward={onForward}
			/>

			<div
				ref={frame}
				className="app-frame relative grid min-h-0 overflow-hidden"
				style={{
					gridColumn: "1 / -1",
					gridRow: "2",
					gridTemplateColumns: template,
				}}
				data-sidebar-collapsed={sidebarCollapsed || undefined}
				data-rightbar-collapsed={cols.rightbar === 0 || undefined}
				data-rightbar-fullscreen={fullscreen || undefined}
				data-dragging={dragging || undefined}
			>
				<div className="min-w-0 overflow-hidden">{sidebarCollapsed ? null : sidebar}</div>
				<div className="main flex min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
				<div className="min-w-0 overflow-hidden">{cols.rightbar > 0 ? rightbar : null}</div>

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
