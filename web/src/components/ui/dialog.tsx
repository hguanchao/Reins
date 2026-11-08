import { X } from "lucide-react";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "./cn.ts";

/** 模态对话框：正文独立滚动、底部操作固定；打开时把焦点移进面板，Escape 与点遮罩都关闭。 */
export function Dialog({
	open,
	onClose,
	title,
	children,
	footer,
	wide,
	className,
}: {
	readonly open: boolean;
	onClose(): void;
	readonly title: string;
	readonly children: ReactNode;
	readonly footer?: ReactNode;
	readonly wide?: boolean;
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
			className="dialog-mask"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className={cn("dialog", wide === true && "wide", className)}
			>
				<div className="dialog-h">
					<span className="t">{title}</span>
					<button type="button" className="dialog-x" aria-label="关闭" onClick={onClose}>
						<X className="ic ic-14" />
					</button>
				</div>
				<div className="dialog-b">{children}</div>
				{footer === undefined ? null : <div className="dialog-f">{footer}</div>}
			</div>
		</div>,
		document.body,
	);
}
