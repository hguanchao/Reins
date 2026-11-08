import { useEffect, useState } from "react";

/**
 * 会话流内的划选引用。
 *
 * 只认容器内的选区；滚动或点开别处即收起。浮层位置跟着选区走，贴近顶部时改弹到下方。
 */

export interface SelectionAnchor {
	readonly x: number;
	readonly y: number;
	readonly below: boolean;
	readonly text: string;
}

export interface SelectionQuote {
	readonly selection: SelectionAnchor | undefined;
	clear(): void;
}

export function useSelectionQuote(container: { readonly current: HTMLElement | null }): SelectionQuote {
	const [selection, setSelection] = useState<SelectionAnchor | undefined>(undefined);

	useEffect(() => {
		const onSelection = (): void => {
			const active = document.getSelection();
			if (active === null || active.isCollapsed) {
				setSelection(undefined);
				return;
			}
			const text = active.toString().trim();
			const element = container.current;
			if (text.length === 0 || element === null || !element.contains(active.anchorNode)) {
				setSelection(undefined);
				return;
			}
			const rect = active.getRangeAt(0).getBoundingClientRect();
			const below = rect.top < 80;
			setSelection({ x: rect.left + rect.width / 2, y: below ? rect.bottom + 8 : rect.top - 8, below, text });
		};
		document.addEventListener("selectionchange", onSelection);
		const clear = (): void => setSelection(undefined);
		window.addEventListener("scroll", clear, true);
		return () => {
			document.removeEventListener("selectionchange", onSelection);
			window.removeEventListener("scroll", clear, true);
		};
	}, [container]);

	return { selection, clear: () => setSelection(undefined) };
}
