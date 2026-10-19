import {
	assistantText,
	assistantToolCalls,
	userText,
	type LlmMessage,
} from "../llm/messages.ts";
import type { TranscriptTurn } from "./transcript.ts";

/**
 * 把会话消息折叠成对话流。
 *
 * 续聊时模型能看到的历史必须同样出现在界面上，否则页脚显示有上下文、对话区却是一片空白。
 * 压缩摘要不当作使用者提示展示；工具调用保留一行参数摘要，工具结果保留首行。
 */

const SUMMARY_PREFIX = "(Summary of the earlier conversation, kept so the work can continue)";
const MAX_LINE = 200;

interface MutableTurn extends TranscriptTurn {
	response: string[];
}

export function buildTranscriptHistory(
	messages: readonly LlmMessage[],
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
					turn.response.push(`· ${call.name} ${summarizeArgs(call.arguments)}`);
				}
				break;
			}
			case "toolResult": {
				const turn = ensureTurn("(earlier conversation)");
				const first = firstLine(message.content);
				turn.response.push(message.isError ? `  failed: ${first}` : `  done: ${first}`);
				break;
			}
		}
	}

	return turns;
}

function summarizeArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function firstLine(content: string): string {
	const line = content.split("\n", 1)[0] ?? "";
	return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
}
