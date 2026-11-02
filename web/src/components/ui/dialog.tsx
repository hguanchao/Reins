import { X } from "lucide-react";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./button.tsx";
import { cn } from "./cn.ts";

/** 模态对话框；打开时把焦点移进面板，Escape 与点遮罩都关闭。 */
export function Dialog({
	open,
	onClose,
	title,
	children,
	footer,
	className,
}: {
	readonly open: boolean;
	onClose(): void;
	readonly title: string;
	readonly children: ReactNode;
	readonly footer?: ReactNode;
	readonly className?: string;
}): ReactElement | null {
	const panelRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: globalThis.KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		const first = panelRef.current?.querySelector<HTMLElement>(
			"button:not(:disabled), [href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
		);
		first?.focus();
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;
	return createPortal(
		<div
			className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className={cn(
					"w-full max-w-lg rounded-2xl border border-popover-border bg-popover p-4 shadow-md animate-pop",
					className,
				)}
			>
				<div className="mb-3 flex items-center justify-between gap-3">
					<h2 className="text-ui-base font-semibold text-foreground">{title}</h2>
					<Button size="icon-sm" variant="ghost" aria-label="关闭" onClick={onClose}>
						<X className="size-4" />
					</Button>
				</div>
				{children}
				{footer === undefined ? null : <div className="mt-4 flex justify-end gap-2">{footer}</div>}
			</div>
		</div>,
		document.body,
	);
}
