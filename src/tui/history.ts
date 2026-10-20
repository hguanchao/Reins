import {
	assistantText,
	assistantToolCalls,
	userText,
	type LlmMessage,
} from "../llm/messages.ts";
import { describeToolCall, displayToolName } from "../tools/describe.ts";
import { appendToolLine, findToolByCallId, type TranscriptLine, type TranscriptTurn } from "./transcript.ts";

/**
 * 把会话消息折叠成对话流。
 *
 * 续聊时模型能看到的历史必须同样出现在界面上，否则页脚显示有上下文、对话区却是一片空白。
 * 压缩摘要不当作使用者提示展示；工具调用保留一行可读摘要，工具结果只保留失败原因。
 */

const SUMMARY_PREFIX = "(Summary of the earlier conversation, kept so the work can continue)";
const MAX_LINE = 200;

interface MutableTurn extends TranscriptTurn {
	response: TranscriptLine[];
}

export function buildTranscriptHistory(
	messages: readonly LlmMessage[],
	workspaceRoot?: string,
): readonly TranscriptTurn[] {
	const turns: MutableTurn[] = [];
	let current: MutableTurn | undefined;

	const ensureTurn = (prompt: string): MutableTurn => {
		if (current === undefined) {
			current = { prompt, response: [] };
			turns.push(current);
		}
		return current;
	};

	for (const message of messages) {
		switch (message.role) {
			case "user": {
				const text = userText(message);
				if (text.startsWith(SUMMARY_PREFIX)) continue;
				current = { prompt: text.length > 0 ? text : "[image]", response: [] };
				turns.push(current);
				break;
			}
			case "assistant": {
				const turn = ensureTurn("(earlier conversation)");
				const text = assistantText(message);
				if (text.length > 0) turn.response.push(...text.split("\n"));
				for (const call of assistantToolCalls(message)) {
					const described = describeToolCall(call.name, call.arguments, workspaceRoot);
					appendToolLine(
						turn.response,
						{
							kind: "tool",
							name: described.name,
							detail: described.detail,
							...(described.fullDetail === undefined
								? {}
								: { fullDetail: described.fullDetail }),
							group: described.group,
							callId: call.id,
						},
						false,
					);
				}
				break;
			}
			case "toolResult": {
				if (!message.isError) {
					const turn = ensureTurn("(earlier conversation)");
					const tool = findToolByCallId(turn.response, message.toolCallId);
					if (tool !== undefined) tool.result = message.content;
					break;
				}
				const turn = ensureTurn("(earlier conversation)");
				turn.response.push({
					kind: "tool",
					name: displayToolName(message.toolName),
					detail: firstLine(message.content),
					isError: true,
				});
				break;
			}
		}
	}

	return turns;
}

function firstLine(content: string): string {
	const line = content.split("\n", 1)[0] ?? "";
	return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
}
