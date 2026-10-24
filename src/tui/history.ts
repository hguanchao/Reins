import {
	assistantText,
	assistantToolCalls,
	userText,
	type LlmMessage,
} from "../llm/messages.ts";
import { describeToolCall, displayToolName, sanitizeDetail } from "../tools/describe.ts";
import { todoCardFromArgs } from "./todo-card.ts";
import {
	appendToolLine,
	attachToolFailure,
	attachToolResult,
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
					// 同一条 assistant 消息里的多个子代理调用回填为同一个组,与实时归组一致
					if (call.name === "subagent") {
						appendSubagentMember(turn.response, call.id, subagentTaskOf(call.arguments));
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
				// 子代理的结果改组员状态,不落普通工具行
				if (message.toolName === "subagent" && attachSubagentResult(turns, message)) break;
				if (!message.isError) {
					const turn = ensureTurn("(earlier conversation)");
					const tool = findToolByCallId(turn.response, message.toolCallId);
					if (tool !== undefined) {
						attachToolResult(tool, message.toolName, message.content);
					}
					break;
				}
				const turn = ensureTurn("(earlier conversation)");
				const tool = findTopLevelToolByCallId(turn.response, message.toolCallId);
				if (tool !== undefined) {
					// 与实时一致：失败结果改调用行本身，错误详情留给双击展开
					attachToolFailure(tool, sanitizeDetail(message.content));
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

/** 派发参数里的任务描述;形状不对就给一句占位,清单行总得有字。 */
function subagentTaskOf(args: Record<string, unknown>): string {
	const task = args["task"];
	return typeof task === "string" && task.length > 0 ? task : "(no task)";
}

/** 把子代理调用追加进最近一个组;没有组(跨了消息)或最后一个不是组就开新组。 */
function appendSubagentMember(response: TranscriptLine[], callId: string, task: string): void {
	const last = response.at(-1);
	if (typeof last === "object" && last !== null && last.kind === "subagentGroup") {
		last.members.push({ callId, task, status: "done" });
		return;
	}
	// 回填无法还原运行期起点,组耗时按 0 占位;终态由结果改写
	response.push({ kind: "subagentGroup", members: [{ callId, task, status: "done" }], startedAt: 0, durationMs: undefined, expanded: false });
}

/** 子代理结果挂回组员:终态与失败原因落定;不是子代理结果返回 false。 */
function attachSubagentResult(
	turns: readonly MutableTurn[],
	message: Extract<LlmMessage, { role: "toolResult" }>,
): boolean {
	for (const turn of turns) {
		for (const line of turn.response) {
			if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
			const member = line.members.find((item) => item.callId === message.toolCallId);
			if (member === undefined) continue;
			member.status = message.isError ? "failed" : "done";
			if (message.isError) member.failure = firstLine(message.content);
			return true;
		}
	}
	return false;
}
