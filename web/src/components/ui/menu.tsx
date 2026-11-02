import { Check, type LucideIcon } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "./cn.ts";

/** 菜单条目：普通动作、分隔线或分组标题。 */
export type MenuEntry =
	| { readonly type: "separator" }
	| { readonly type: "label"; readonly label: string }
	| {
			readonly type: "item";
			readonly key: string;
			readonly label: string;
			readonly icon?: LucideIcon;
			readonly hint?: string;
			readonly danger?: boolean;
			readonly disabled?: boolean;
			/** 提供时按单选渲染，用勾选标记而不是整行高亮表示选中 */
			readonly checked?: boolean;
			onSelect(): void;
	  };

interface PanelPosition {
	readonly top?: number;
	readonly bottom?: number;
	readonly left?: number;
	readonly right?: number;
	readonly maxHeight: number;
}

/**
 * 下拉菜单。
 *
 * 面板挂在 body 上而不是触发器的子树里：侧栏、页签栏都有 overflow-hidden，直接绝对定位
 * 会被裁掉，甚至让点击落到下层元素。固定定位按触发器矩形算位置，空间不够时向上翻。
 */
export function Menu({
	trigger,
	entries,
	align = "end",
	className,
	wrapperClassName,
}: {
	readonly trigger: (state: { readonly open: boolean; toggle(): void }) => ReactNode;
	readonly entries: readonly MenuEntry[];
	readonly align?: "start" | "end";
	readonly className?: string;
	readonly wrapperClassName?: string;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<PanelPosition | undefined>(undefined);
	const triggerRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);

	const updatePosition = useCallback((): void => {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect === undefined) return;
		const spaceBelow = window.innerHeight - rect.bottom;
		const openUp = spaceBelow < 260 && rect.top > spaceBelow;
		const maxHeight = Math.max(120, Math.min(384, openUp ? rect.top - 8 : spaceBelow - 8));
		// 估算宽度只用于决定向左还是向右展开；贴边时换一侧，避免面板伸出窗口
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
		const first = panelRef.current?.querySelector<HTMLButtonElement>("[data-menu-item]:not(:disabled)");
		first?.focus();
	}, [open]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
			return;
		}
		const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]:not(:disabled)") ?? [])];
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === "Home") items[0]?.focus();
		else if (event.key === "End") items[items.length - 1]?.focus();
		else if (event.key === "ArrowDown") items[(current + 1) % items.length]?.focus();
		else items[(current - 1 + items.length) % items.length]?.focus();
	};

	return (
		<div ref={triggerRef} className={cn("relative inline-flex", wrapperClassName)}>
			{trigger({ open, toggle: () => setOpen((value) => !value) })}
			{open
				? createPortal(
						<>
							<div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
							<div
								ref={panelRef}
								role="menu"
								onKeyDown={onKeyDown}
								style={{
									position: "fixed",
									top: position?.top,
									bottom: position?.bottom,
									left: position?.left,
									right: position?.right,
									maxHeight: position?.maxHeight,
								}}
								className={cn(
									"z-50 min-w-52 overflow-y-auto rounded-lg border border-popover-border bg-menu p-1 shadow-md animate-pop",
									className,
								)}
							>
								{entries.map((entry, index) => {
									if (entry.type === "separator") {
										return <div key={`sep-${index}`} role="separator" className="-mx-1 my-1 h-px bg-border" />;
									}
									if (entry.type === "label") {
										return (
											<div
												key={`label-${index}`}
												className="px-2 py-1 text-ui-xs font-medium text-foreground-subtlest"
											>
												{entry.label}
											</div>
										);
									}
									const Icon = entry.icon;
									return (
										<button
											key={entry.key}
											type="button"
											role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
											aria-checked={entry.checked}
											disabled={entry.disabled}
											data-menu-item
											onClick={() => {
												setOpen(false);
												entry.onSelect();
											}}
											className={cn(
												"flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui-base transition-colors",
												entry.danger
													? "text-destructive hover:bg-destructive-surface"
													: "text-foreground hover:bg-menu-hover",
												entry.disabled && "pointer-events-none opacity-50",
											)}
										>
											{Icon === undefined ? null : <Icon className="size-4 shrink-0 text-foreground-subtlest" />}
											<span className="min-w-0 flex-1 truncate">{entry.label}</span>
											{entry.hint === undefined ? null : (
												<span className="shrink-0 text-ui-xs text-foreground-subtlest">{entry.hint}</span>
											)}
											{entry.checked === true ? <Check className="size-4 shrink-0" /> : null}
										</button>
									);
								})}
							</div>
						</>,
						document.body,
					)
				: null}
		</div>
	);
}
