import type { ReactElement } from "react";

/** 用户消息：右对齐的浅蓝气泡，宽度跟随内容列。 */
export function UserMessage({ text }: { readonly text: string }): ReactElement {
	return (
		<div className="flex justify-end">
			<div
				data-user-bubble
				className="max-w-[min(calc(var(--chat-content-width)*0.702),82%)] whitespace-pre-wrap break-words rounded-[20px] bg-user-message-bubble px-4 py-2.5 text-foreground"
				style={{ fontSize: "var(--content-font-size)", lineHeight: "22px" }}
			>
				{text}
			</div>
		</div>
	);
}
