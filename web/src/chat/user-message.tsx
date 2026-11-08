import type { ReactElement } from "react";

/** 路径片段：含路径分隔符的西文 token，与回答里的行内代码同一种语气。 */
const PATH_PATTERN = /(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.-]*/g;

/** 提问文本里的路径渲染成等宽小片，其余文本原样保留换行。 */
function withPaths(text: string): readonly (string | ReactElement)[] {
	const nodes: (string | ReactElement)[] = [];
	let cursor = 0;
	for (const match of text.matchAll(PATH_PATTERN)) {
		const start = match.index ?? 0;
		if (start > cursor) nodes.push(text.slice(cursor, start));
		nodes.push(
			<span key={`path-${start}`} className="path">
				{match[0]}
			</span>,
		);
		cursor = start + match[0].length;
	}
	if (cursor < text.length) nodes.push(text.slice(cursor));
	return nodes;
}

/**
 * 用户提问：右侧浅底气泡，最大 76% 宽，10px 圆角。
 *
 * 用户在右、模型在左，与主流 agent 会话同构；不用等宽大写署名与通栏细线。
 */
export function UserMessage({ text, lineIndex }: { readonly text: string; readonly lineIndex: number }): ReactElement {
	return (
		<div className="ask" data-user-bubble data-user-line={lineIndex}>
			<p>{withPaths(text)}</p>
		</div>
	);
}

/** 会话流的提示行：失败给斜纹底，普通提示只降一级明度。 */
export function NoticeLine({
	text,
	tone,
}: {
	readonly text: string;
	readonly tone: "info" | "error";
}): ReactElement {
	return (
		<div
			className="flex items-start gap-2 px-2 py-1.5 text-[var(--fs-12)] leading-[1.65]"
			style={{
				color: tone === "error" ? "var(--ink)" : "var(--ink-3)",
				background: tone === "error" ? "var(--hatch-soft)" : undefined,
			}}
		>
			<span className="min-w-0 break-words">{text}</span>
		</div>
	);
}
