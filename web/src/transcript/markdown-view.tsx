import { useMemo, type ReactElement } from "react";

import { handleCopyClick, renderMarkdown } from "./markdown.ts";

/** 助手文本的 markdown 渲染;流式期间补齐未闭合围栏,复制按钮走事件委托。 */
export function MarkdownView({ text, streaming }: { text: string; streaming: boolean }): ReactElement {
	const html = useMemo(() => renderMarkdown(text, streaming), [text, streaming]);
	return (
		<div
			className="md text-ui-base leading-[1.75] tracking-wide"
			dangerouslySetInnerHTML={{ __html: html }}
			onClick={(event) => {
				handleCopyClick(event.nativeEvent);
			}}
		/>
	);
}
