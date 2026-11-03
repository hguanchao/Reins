import type { ReactElement } from "react";

/** 用户消息:右对齐的浅色气泡,右上角收小,支持 squircle 时换成更柔和的超椭圆。 */
export function UserMessage({ text }: { readonly text: string }): ReactElement {
	return (
		<div className="flex justify-end">
			<div
				data-user-bubble
				className="max-w-xl whitespace-pre-wrap break-words rounded-xl rounded-tr-xs border border-border bg-user-message-bubble px-4 py-3 text-ui-base text-foreground"
			>
				{text}
			</div>
		</div>
	);
}
