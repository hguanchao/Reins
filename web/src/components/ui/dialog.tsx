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
				className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 p-4"
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
						"dialog-material w-full max-w-lg rounded-[28px] p-5 animate-panel-in",
						className,
					)}
				>
					<div className="mb-4 flex items-center justify-between gap-3">
						<h2 className="text-[16px] leading-6 font-medium text-foreground">{title}</h2>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="关闭"
							className="rounded-sm"
							onClick={onClose}
						>
							<X className="size-4" />
						</Button>
					</div>
					{children}
					{footer === undefined ? null : <div className="mt-5 flex justify-end gap-2">{footer}</div>}
				</div>
			</div>,
			document.body,
		);
}
