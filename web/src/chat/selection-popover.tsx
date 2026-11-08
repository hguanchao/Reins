import type { ReactElement } from "react";

import type { SelectionAnchor } from "../state/use-selection-quote.ts";

/**
 * 划选文本后浮出的迷你工具条。
 *
 * 引用写进输入框、复制写入剪贴板；两个动作都要顺手清掉选区，否则工具条会赖在原地。
 */
export function SelectionPopover({
	anchor,
	onQuote,
	onClose,
}: {
	readonly anchor: SelectionAnchor;
	onQuote(text: string): void;
	onClose(): void;
}): ReactElement {
	const finish = (quote: boolean): void => {
		if (quote) onQuote(anchor.text);
		else void navigator.clipboard.writeText(anchor.text);
		onClose();
		document.getSelection()?.removeAllRanges();
	};

	return (
		<div
			className="sel-pop"
			style={{
				left: anchor.x,
				top: anchor.y,
				transform: `translate(-50%, ${anchor.below ? "0" : "-100%"})`,
			}}
		>
			<button type="button" onClick={() => finish(true)}>
				引用
			</button>
			<button type="button" onClick={() => finish(false)}>
				复制
			</button>
		</div>
	);
}
