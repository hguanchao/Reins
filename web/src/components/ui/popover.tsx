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
	placement = "auto",
	className,
	zIndex,
}: {
	readonly trigger: (state: { readonly open: boolean; toggle(): void }) => ReactNode;
	readonly children: ReactNode | ((close: () => void) => ReactNode);
	readonly align?: "start" | "end";
	/** 输入卡的浮层一律向上翻：向下会盖住下方的起点建议与状态条。 */
	readonly placement?: "above" | "auto";
	readonly className?: string;
	/** 弹层里的浮层要压过遮罩；不传时用默认层级。 */
	readonly zIndex?: number;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<PanelPosition | undefined>(undefined);
	const triggerRef = useRef<HTMLDivElement | null>(null);

	const updatePosition = useCallback((): void => {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect === undefined) return;
		const spaceBelow = window.innerHeight - rect.bottom;
		// 输入卡贴着窗口下沿，设计稿的浮层固定用 bottom 贴触发行上沿；
		// 只有上方真的放不下时才退回向下，避免整块跑出视口。
		const openUp =
			placement === "above" ? rect.top > 160 : spaceBelow < 300 && rect.top > spaceBelow;
		const maxHeight = Math.max(160, Math.min(420, openUp ? rect.top - 12 : spaceBelow - 12));
		const estimated = 300;
		const useLeft =
			align === "start" ? rect.left + estimated <= window.innerWidth - 8 : rect.right - estimated < 8;
		setPosition({
			...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
			...(useLeft
				? { left: Math.max(8, rect.left) }
				: { right: Math.max(8, window.innerWidth - rect.right) }),
			maxHeight,
		});
	}, [align, placement]);

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
							<div
								className="fixed inset-0 z-40"
								style={zIndex === undefined ? undefined : { zIndex }}
								aria-hidden="true"
								onClick={() => setOpen(false)}
							/>
							<div
								role="dialog"
								style={{
									position: "fixed",
									top: position?.top,
									bottom: position?.bottom,
									left: position?.left,
									right: position?.right,
									maxHeight: position?.maxHeight,
									...(zIndex === undefined ? {} : { zIndex: zIndex + 1 }),
								}}
								className={cn("pop animate-pop z-50 overflow-y-auto", className)}
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
