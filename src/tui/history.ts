import {
	assistantText,
	assistantToolCalls,
	userText,
	type LlmMessage,
} from "../llm/messages.ts";
import { describeToolCall, displayToolName, sanitizeDetail } from "../tools/describe.ts";
import { resultDetail, resultMetric } from "../tools/result-summary.ts";
import { todoCardFromArgs } from "./todo-card.ts";
import {
	appendToolLine,
	collapseToolGroups,
	findToolByCallId,
	findTopLevelToolByCallId,
	type TranscriptLine,
	type TranscriptTurn,
} from "./transcript.ts";

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
				if (text.length > 0) turn.response.push({ kind: "markdown", text });
				for (const call of assistantToolCalls(message)) {
					// 任务卡片与实时路径共用同一份参数解析；解析不了的形状退回普通工具行
					const card = call.name === "todo" ? todoCardFromArgs(call.arguments) : undefined;
					if (card !== undefined) {
						turn.response.push(card);
						continue;
					}
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
							...(described.linkTarget === undefined
								? {}
								: { linkTarget: described.linkTarget }),
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
					if (tool !== undefined) {
						tool.result = message.content;
						const metric = resultMetric(message.toolName, undefined, message.content);
						if (metric !== undefined) tool.metric = metric;
						const detail = resultDetail(message.toolName, message.content);
						if (detail !== undefined) {
							tool.fullDetail = detail.text;
							tool.detailKind = detail.kind;
						}
					}
					break;
				}
				const turn = ensureTurn("(earlier conversation)");
				const tool = findTopLevelToolByCallId(turn.response, message.toolCallId);
				if (tool !== undefined) {
					// 与实时一致：失败结果改调用行本身，错误详情留给双击展开
					tool.isError = true;
					tool.detailKind = "text";
					const errorText = sanitizeDetail(message.content);
					const command = tool.fullDetail ?? tool.detail;
					tool.fullDetail = errorText.length > 0 ? `${command}\n\n${errorText}` : command;
					break;
				}
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

	// 回填等价于回合结束：命令组在这里塌缩，与实时路径共用同一套判定
	for (const turn of turns) collapseToolGroups(turn.response);

	return turns;
}

function firstLine(content: string): string {
	const line = content.split("\n", 1)[0] ?? "";
	return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
}
