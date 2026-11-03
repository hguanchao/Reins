import type { Line } from "../transcript/lines.ts";

/** 右侧轨迹的一条：会话流下标与提问摘要。 */
export interface UserMessageAnchor {
	readonly index: number;
	readonly text: string;
}

/** 按出现顺序取出用户消息；空白折成单个空格，连续对话里一行只占一条。 */
export function userMessageAnchors(lines: readonly Line[]): readonly UserMessageAnchor[] {
	const anchors: UserMessageAnchor[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line?.kind !== "user") continue;
		anchors.push({ index, text: line.text.replace(/\s+/g, " ").trim() });
	}
	return anchors;
}
