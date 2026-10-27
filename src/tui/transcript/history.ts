import {
	assistantText,
	assistantToolCalls,
	userImages,
	userText,
	type LlmMessage,
} from "../../llm/messages.ts";
import { firstLine } from "../../shared/format.ts";
import { displayToolName, sanitizeDetail } from "../../tools/describe.ts";
import { imageMarker } from "../image.ts";
import { todoCardFinished, todoCardFromArgs, type TranscriptTodo } from "../view/todo-card.ts";
import {
	appendToolLine,
	attachToolFailure,
	attachToolResult,
	collapseToolGroups,
	describeToolLine,
	findToolByCallId,
	takeToolForFailure,
	type TranscriptLine,
	type TranscriptPlan,
	type TranscriptTurn,
} from "../transcript.ts";

/**
 * 把会话消息折叠成对话流。
 *
 * 续聊时模型能看到的历史必须同样出现在界面上，否则页脚显示有上下文、对话区却是一片空白。
 * 压缩摘要不当作使用者提示展示；工具调用保留一行可读摘要，工具结果只保留失败原因。
 * 已收尾的任务卡属于历史，回填进对话流；最后一张未收尾的卡单独带出，交给常驻面板。
 */

/** 历史工具行的首行上限；过长时截断加省略号。 */
const MAX_LINE = 200;
const SUMMARY_PREFIX = "(Summary of the earlier conversation, kept so the work can continue)";

interface MutableTurn extends TranscriptTurn {
	response: TranscriptLine[];
}

interface TranscriptHistory {
	readonly turns: readonly TranscriptTurn[];
	/** 最后一张未收尾的任务表；续聊时用它恢复常驻面板 */
	readonly todo?: TranscriptTodo;
	/** 最近一份计划；重启或切会话后仍能从 /view-plan 打开 */
	readonly plan?: TranscriptPlan;
}

export function buildTranscriptHistory(
	messages: readonly LlmMessage[],
	workspaceRoot?: string,
): TranscriptHistory {
	const turns: MutableTurn[] = [];
	let current: MutableTurn | undefined;
	let lastTodo: TranscriptTodo | undefined;
	let lastPlan: TranscriptPlan | undefined;

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
				// 新消息的正文已经带标记；旧会话里没有标记的图片补在提示块末尾，不另起回复行
				const markers = userImages(message)
					.map((image) => imageMarker(image.name))
					.filter((marker) => !text.includes(marker));
				const prompt = [text, ...markers].filter((part) => part.length > 0).join(" ");
				current = { prompt: prompt.length > 0 ? prompt : "[image]", response: [] };
				turns.push(current);
				break;
			}
			case "assistant": {
				let turn: MutableTurn | undefined;
				const currentTurn = (): MutableTurn =>
					(turn ??= ensureTurn("(earlier conversation)"));
				const text = assistantText(message);
				if (text.length > 0) currentTurn().response.push({ kind: "markdown", text });
				for (const call of assistantToolCalls(message)) {
					// 任务表与实时路径共用同一份参数解析；解析不了的形状退回普通工具行
					if (call.name === "todo") {
						const card = todoCardFromArgs(call.arguments);
						if (card !== undefined) {
							lastTodo = card;
							// 收尾的列表是历史，回到对话流；未收尾的留给常驻面板
							if (todoCardFinished(card)) currentTurn().response.push(card);
							continue;
						}
					}
					// 计划正文在工具参数里；成功结果没有对应的普通工具行，历史只还原计划卡
					if (call.name === "present_plan") {
						const text = planTextFromArgs(call.arguments);
						if (text !== undefined) {
							const plan: TranscriptPlan = { kind: "plan", text };
							currentTurn().response.push(plan);
							lastPlan = plan;
							continue;
						}
					}
					// 同一条 assistant 消息里的多个子代理调用回填为同一个组,与实时归组一致
					if (call.name === "subagent") {
						appendSubagentMember(currentTurn().response, call.id, subagentTaskOf(call.arguments));
						continue;
					}
					appendToolLine(
						currentTurn().response,
						describeToolLine(call.name, call.arguments, call.id, workspaceRoot),
						false,
					);
				}
				break;
			}
			case "toolResult": {
				// 子代理的结果改组员状态,不落普通工具行
				if (message.toolName === "subagent" && attachSubagentResult(turns, message)) break;
				if (!message.isError) {
					// 成功结果只挂回已有工具行；没有当前回合说明对应的调用没有落行(任务表)，不凭空造一个空回合
					if (current === undefined) break;
					const tool = findToolByCallId(current.response, message.toolCallId);
					if (tool !== undefined) {
						attachToolResult(tool, message.toolName, message.content);
					}
					break;
				}
				const turn = ensureTurn("(earlier conversation)");
				const tool = takeToolForFailure(turn.response, message.toolCallId);
				if (tool !== undefined) {
					// 与实时一致：失败结果改调用行本身，错误详情留给双击展开
					attachToolFailure(tool, sanitizeDetail(message.content));
					break;
				}
				turn.response.push({
					kind: "tool",
					name: displayToolName(message.toolName),
					detail: firstLine(message.content, MAX_LINE),
					isError: true,
				});
				break;
			}
		}
	}

	// 回填等价于回合结束：命令组在这里塌缩，与实时路径共用同一套判定
	for (const turn of turns) collapseToolGroups(turn.response);

	const todo =
		lastTodo !== undefined && lastTodo.items.length > 0 && !todoCardFinished(lastTodo)
			? lastTodo
			: undefined;
	return {
		turns,
		...(todo === undefined ? {} : { todo }),
		...(lastPlan === undefined ? {} : { plan: lastPlan }),
	};
}

/** present_plan 的参数只有一份完整计划；空计划不产生卡片。 */
function planTextFromArgs(args: Record<string, unknown>): string | undefined {
	const text = args["plan"];
	return typeof text === "string" && text.trim().length > 0 ? text : undefined;
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
			if (message.isError) member.failure = message.content;
			return true;
		}
	}
	return false;
}
