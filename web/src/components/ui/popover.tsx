import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "./cn.ts";

interface PanelPosition {
	readonly top?: number;
	readonly bottom?: number;
	readonly left?: number;
	readonly right?: number;
	readonly maxHeight: number;
}

/**
 * 浮层。
 *
 * 与菜单共用固定定位与向上翻转：输入卡在窗口底部，向下展开会立刻被裁掉。内容由调用方
 * 决定，需要关闭时用函数式 children。
 */
export function Popover({
	trigger,
	children,
	align = "end",
	className,
}: {
	readonly trigger: (state: { readonly open: boolean; toggle(): void }) => ReactNode;
	readonly children: ReactNode | ((close: () => void) => ReactNode);
	readonly align?: "start" | "end";
	readonly className?: string;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<PanelPosition | undefined>(undefined);
	const triggerRef = useRef<HTMLDivElement | null>(null);

	const updatePosition = useCallback((): void => {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect === undefined) return;
		const spaceBelow = window.innerHeight - rect.bottom;
		const openUp = spaceBelow < 280 && rect.top > spaceBelow;
		const maxHeight = Math.max(120, Math.min(320, openUp ? rect.top - 8 : spaceBelow - 8));
		const estimated = 360;
		const useLeft =
			align === "start" ? rect.left + estimated <= window.innerWidth - 8 : rect.right - estimated < 8;
		setPosition({
			...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
			...(useLeft
				? { left: Math.max(8, rect.left) }
				: { right: Math.max(8, window.innerWidth - rect.right) }),
			maxHeight,
		});
	}, [align]);

	useLayoutEffect(() => {
		if (!open) return;
		updatePosition();
		window.addEventListener("scroll", updatePosition, true);
		window.addEventListener("resize", updatePosition);
		return () => {
			window.removeEventListener("scroll", updatePosition, true);
			window.removeEventListener("resize", updatePosition);
		};
	}, [open, updatePosition]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: globalThis.KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);

	return (
		<div ref={triggerRef} className="relative inline-flex">
			{trigger({ open, toggle: () => setOpen((value) => !value) })}
			{open
				? createPortal(
						<>
							<div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
							<div
								role="dialog"
								style={{
									position: "fixed",
									top: position?.top,
									bottom: position?.bottom,
									left: position?.left,
									right: position?.right,
									maxHeight: position?.maxHeight,
								}}
								className={cn(
									"z-50 overflow-y-auto rounded-xl border border-popover-border bg-popover p-2.5 shadow-md animate-pop",
									className,
								)}
							>
								{typeof children === "function" ? children(() => setOpen(false)) : children}
							</div>
						</>,
						document.body,
					)
				: null}
		</div>
	);
}
