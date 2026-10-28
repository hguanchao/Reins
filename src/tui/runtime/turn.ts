import { displayToolName, sanitizeDetail } from "../../tools/describe.ts";
import { formatDuration } from "../../shared/format.ts";
import type { AgentEvent } from "../../agent/events.ts";
import { todoCardFinished, todoCardFromArgs } from "../view/todo-card.ts";
import type { TranscriptLine, TranscriptPlan, TranscriptThinking } from "../transcript.ts";
import {
	appendToolLine,
	attachToolFailure,
	attachToolResult,
	describeToolLine,
	findToolByCallId,
	findTopLevelToolByCallId,
	hasRunningSubagent,
	isSubagentCall,
	takeToolForFailure,
} from "../transcript.ts";
import {
	COMPACTING_CONTEXT,
	ERROR_STATUS,
	INTERRUPTED,
	RUNNING_TOOL,
	THINKING,
	WAITING_FOR_MODEL,
	WAITING_FOR_SUBAGENT,
	WRITING_RESPONSE,
	WRITING_TOOL_CALL,
	shortReason,
} from "../render/status.ts";
import type { ActiveTurn, TuiHost, TuiState } from "./types.ts";

/**
 * 一轮进行中的事件处理。
 *
 * 模型文本、思考、工具与压缩进度都在这里转成对话流里的行；状态行只描述「现在在做什么」。
 * 除文本与思考增量外，每个事件处理完都会立即重绘——增量由刷新帧统一绘制。
 */

export function closeText(active: ActiveTurn): void {
	active.textBlock = undefined;
}

function appendAssistantText(host: TuiHost, active: ActiveTurn, delta: string): void {
	let block = active.textBlock;
	if (block === undefined) {
		block = { kind: "markdown", text: "" };
		active.textBlock = block;
		active.lines.push(block);
	}
	block.text += delta;
	host.syncTurn(active);
}

/** 思考正文按行实时写入当前区块；最后一段未换行的内容作为临时行显示。 */
function appendThinkingText(host: TuiHost, active: ActiveTurn, delta: string): void {
	const block = active.thinkingBlock;
	if (block === undefined) return;
	block.partial += delta;
	const parts = block.partial.split("\n");
	block.partial = parts.pop() ?? "";
	block.body.push(...parts);
	host.syncTurn(active);
}

/**
 * 一段思考结束。
 *
 * 正文保留在区块里，但默认收起：运行中显示最后五行，结束后只显示标题。双击标题可在
 * 全文和默认状态之间切换。
 */
export function closeThinking(host: TuiHost, active: ActiveTurn): void {
	const startedAt = active.thinkingStartedAt;
	if (startedAt === undefined) return;

	active.thinkingStartedAt = undefined;
	const block = active.thinkingBlock;
	active.thinkingBlock = undefined;
	if (block !== undefined) {
		if (block.partial.length > 0) {
			block.body.push(block.partial);
			block.partial = "";
		}
		block.header = `Thought for ${formatDuration(Date.now() - startedAt)}`;
		block.running = false;
		block.expanded = false;
	}
	host.syncTurn(active);
}

/**
 * 计划提交：对话流只放一张计划卡，完整正文留给审批页。
 *
 * 空计划不建卡，让它落回普通工具行，工具返回的错误才有地方显示。有效计划在回合结束时
 * 自动打开审批页；latest 同时更新，供计划卡重新打开。
 */
function handlePlanStart(
	host: TuiHost,
	state: TuiState,
	active: ActiveTurn,
	event: Extract<AgentEvent, { type: "tool_start" }>,
): boolean {
	if (event.name !== "present_plan" || !host.planning()) return false;
	const text = event.args["plan"];
	if (typeof text !== "string" || text.trim().length === 0) return false;

	const plan: TranscriptPlan = { kind: "plan", text };
	host.appendLine(active, plan);
	state.latestPlan = plan;
	state.pendingPlan = plan;
	return true;
}

/**
 * 任务卡片按生命周期分流：未收尾的进常驻面板，已收尾的落回对话流并清空面板。
 * 解析不了的形状返回 false 落回普通工具行，后面校验阶段的错误信息才有行可挂。
 */
function handleTodoCardStart(
	host: TuiHost,
	state: TuiState,
	active: ActiveTurn,
	event: Extract<AgentEvent, { type: "tool_start" }>,
): boolean {
	// Plan 模式下任务工具不在工具清单里；幻觉调用应落回普通错误行，不更新任务面板
	if (event.name !== "todo" || host.planning()) return false;
	const card = todoCardFromArgs(event.args);
	if (card === undefined) return false;

	// 空表表示清空；面板与对话流都不留痕迹
	if (card.items.length === 0) {
		state.currentTodo = undefined;
		return true;
	}

	// 收尾：整张卡作为历史落进对话流，面板退出
	if (todoCardFinished(card)) {
		card.running = false;
		host.appendLine(active, card);
		state.currentTodo = undefined;
		return true;
	}

	card.running = true;
	const current = card.items.find((item) => item.status === "in_progress");
	if (current !== undefined) {
		// 计时起点：同一任务在上一张卡片里也进行时继承，否则从现在起算
		const previousCard = state.currentTodo;
		const previous = previousCard?.items.find((item) => item.status === "in_progress");
		card.taskStartedAt =
			previousCard?.taskStartedAt !== undefined && previous?.content === current.content
				? previousCard.taskStartedAt
				: Date.now();
	}
	state.currentTodo = card;
	return true;
}

/**
 * 子代理调用进组:本回合已有组就追加成员,否则开新组。
 * 返回 true 表示这个调用已被组消化,不再落普通工具行。
 */
function handleSubagentStart(
	host: TuiHost,
	active: ActiveTurn,
	event: Extract<AgentEvent, { type: "tool_start" }>,
): boolean {
	if (event.name !== "subagent" || host.planning()) return false;
	const task = typeof event.args["task"] === "string" ? event.args["task"] : "";
	const last = active.lines.at(-1);
	if (typeof last === "object" && last !== null && last.kind === "subagentGroup") {
		last.members.push({ callId: event.callId, task, status: "running" });
	} else {
		host.appendLine(active, {
			kind: "subagentGroup",
			members: [{ callId: event.callId, task, status: "running" }],
			startedAt: Date.now(),
			expanded: false,
		});
	}
	return true;
}

/** 子代理结果挂回组里的成员:终态与耗时、失败原因都在这里落定。 */
function handleSubagentEnd(
	active: ActiveTurn,
	event: Extract<AgentEvent, { type: "tool_end" }>,
): boolean {
	if (event.name !== "subagent") return false;
	for (const line of active.lines) {
		if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
		const member = line.members.find((item) => item.callId === event.callId);
		if (member === undefined) continue;
		const details = event.details as
			| { durationMs?: number; lastActivity?: string; steps?: number; totalTokens?: number }
			| undefined;
		member.status = event.isError ? "failed" : "done";
		member.durationMs = details?.durationMs ?? event.durationMs;
		member.steps = details?.steps;
		member.totalTokens = details?.totalTokens;
		if (event.isError) member.failure = event.content ?? event.summary;
		// 组内最后一个还在跑的结束了,整组的总耗时与 token 合计定格
		if (line.members.every((item) => item.status !== "running")) {
			line.durationMs = Date.now() - line.startedAt;
			line.totalTokens = line.members.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0);
		}
		return true;
	}
	return false;
}

/** 构造事件监听器；事件只作用于它所属的那一轮。 */
export function createEventTarget(host: TuiHost): (event: AgentEvent) => void {
	const { state } = host;
	return (event: AgentEvent): void => {
		const active = state.activeTurn;
		if (active === undefined) return;

		switch (event.type) {
			case "turn_start":
				host.setStatus(WAITING_FOR_MODEL);
				break;
			case "writing_tool_call":
				// 参数还在流里，工具没开始跑；不能提前显示成 Running
				host.setStatus(WRITING_TOOL_CALL);
				break;
			case "text_delta":
				closeThinking(host, active);
				appendAssistantText(host, active, event.text);
				host.setStatus(WRITING_RESPONSE);
				break;
			case "reasoning_delta":
				// 思考开始：插入区块；正文实时写入，运行时默认只显示最后五行。
				// 不关闭当前文本块：同一条 assistant 消息的文本继续写回原来的块，思考块单独插在
				// 它后面。这样迟到的思考片段不会把一句话切成两段。
				if (active.thinkingBlock === undefined && event.text.trim().length === 0) {
					// 纯空白的思考没有可显示内容，不建一个只有标题的空块
					host.setStatus(THINKING);
					break;
				}
				if (active.thinkingBlock === undefined) {
					const startedAt = Date.now();
					active.thinkingStartedAt = startedAt;
					active.thinkingSecond = 0;
					const block: TranscriptThinking = {
						kind: "thinkingBlock",
						header: "Thinking…",
						startedAt,
						body: [],
						partial: "",
						running: true,
						expanded: false,
					};
					active.thinkingBlock = block;
					active.lines.push(block);
					host.syncTurn(active);
				}
				appendThinkingText(host, active, event.text);
				host.setStatus(THINKING);
				break;
			case "tool_start": {
				closeThinking(host, active);
				if (handlePlanStart(host, state, active, event)) {
					host.setStatus(WAITING_FOR_MODEL);
					break;
				}
				if (handleTodoCardStart(host, state, active, event)) {
					// 任务表不产生模型等待：这一行已经交给面板处理，状态只需离开响应阶段
					host.setStatus(RUNNING_TOOL);
					break;
				}
				if (handleSubagentStart(host, active, event)) {
					host.setStatus(WAITING_FOR_SUBAGENT);
					break;
				}
				const tool = describeToolLine(event.name, event.args, event.callId, host.options.workspaceRoot);
				closeText(active);
				if (appendToolLine(active.lines, tool, true)) host.syncTurnFull(active);
				else host.syncTurn(active);
				host.setStatus(`Running ${tool.name}...`);
				break;
			}
			case "tool_update":
				// 子代理的每一步进度仍是「等它回来」，不能显示成普通工具在跑
				host.setStatus(isSubagentCall(active.lines, event.callId) ? WAITING_FOR_SUBAGENT : RUNNING_TOOL);
				break;
			case "tool_end":
				// 有效计划没有普通工具行可挂结果；无效调用仍按失败行处理
				if (
					event.name === "present_plan" &&
					findTopLevelToolByCallId(active.lines, event.callId) === undefined
				) {
					host.setStatus(WAITING_FOR_MODEL);
					break;
				}
				if (handleSubagentEnd(active, event)) {
					host.markTranscriptDirty();
					// 并行派发时还有一个在跑就继续等它，不能提前回到模型等待
					host.setStatus(hasRunningSubagent(active.lines) ? WAITING_FOR_SUBAGENT : WAITING_FOR_MODEL);
					break;
				}
				// 成功不落行：工具调用本身已经显示；结果挂到调用行，Ctrl+O 可展开
				if (event.isError) {
					// 失败行可能刚从组里摘出来，结构变了要整体同步，不能只标脏
					const tool = takeToolForFailure(active.lines, event.callId);
					if (tool !== undefined) {
						// 失败行就是调用行本身：保留命令与耗时，错误详情留给双击展开
						attachToolFailure(tool, sanitizeDetail(event.content ?? event.summary), event.durationMs);
						host.syncTurnFull(active);
					} else {
						host.appendLine(active, {
							kind: "tool",
							name: displayToolName(event.name),
							detail: event.summary,
							isError: true,
							durationMs: event.durationMs,
						});
					}
				} else {
					const tool = findToolByCallId(active.lines, event.callId);
					if (tool !== undefined) {
						attachToolResult(tool, event.name, event.content ?? event.summary, event.durationMs, event.details);
						host.markTranscriptDirty();
					}
				}
				// 工具结果已经写回会话，下一回合的请求就要发出
				host.setStatus(WAITING_FOR_MODEL);
				break;
			case "compaction_start":
				host.appendLine(
					active,
					`· compacting context (${event.messages} messages, ~${event.tokensBefore} tokens)`,
				);
				host.setStatus(COMPACTING_CONTEXT);
				break;
			case "compaction_end":
				host.appendLine(
					active,
					`  compacted: ~${event.tokensBefore} → ~${event.tokensAfter} tokens`,
				);
				host.options.agent?.refreshInfo();
				break;
			case "compaction_failed":
				host.appendLine(active, { text: `Error: ${event.message}`, kind: "error" });
				break;
			case "compaction_skipped":
				host.appendLine(active, `  ${event.message}`);
				break;
			case "notice":
				// 与这一轮无关的提示走状态行：它不该占对话流的位置，看一眼就够了；
				// 提示不是活动，不能带着转圈让人以为还在跑
				host.setStatus(event.message, "notice");
				host.render();
				break;
			case "usage_recorded":
				// 压缩请求花掉的 token 属于压缩成本，不算这一轮对话的用量
				if (event.kind === "turn") active.tokensUsed += event.tokens;
				state.statusTokens = active.tokensUsed;
				// 每次请求的用量都反映到页脚上，不必等整轮跑完
				host.options.agent?.refreshInfo();
				break;
			case "retrying": {
				// 动作在前：先说明系统正在重试，再用冒号补上这一次失败的原因
				const retry = `Retrying (${event.attempt}/${event.maxAttempts})`;
				const reason = shortReason(event.reason).replace(/[.…]+$/, "");
				host.setStatus(reason.length === 0 ? `${retry}...` : `${retry}: ${reason}...`, "warning");
				break;
			}
			case "error":
				closeThinking(host, active);
				host.appendLine(active, { text: `Error: ${event.message}`, kind: "error" });
				active.outcome = "error";
				host.setStatus(ERROR_STATUS, "error");
				break;
			case "aborted":
				closeThinking(host, active);
				// 使用者主动停下不是错误：用中性说明，不染错误色，也不加错误标记。
				// 状态行直接清空，不再留一个「已停下」的静态结局
				host.appendLine(active, { text: INTERRUPTED, kind: "info" });
				active.outcome = "aborted";
				host.clearStatus();
				break;
			case "turn_end":
				// 只思考、没产出正文也没调工具的一次请求，摘要行也要落下
				closeThinking(host, active);
				closeText(active);
				break;
			case "run_end":
				closeText(active);
				break;
		}

		// 文本增量由 100ms 刷新帧统一绘制；工具、错误等阶段变化立即重画
		if (
			event.type !== "text_delta" &&
			event.type !== "reasoning_delta" &&
			event.type !== "tool_update" &&
			event.type !== "turn_end" &&
			event.type !== "run_end"
		) {
			host.render();
		}
	};
}

/** 回合收尾时冻结子代理：没等到结果的成员按失败落定，组的总耗时定格。 */
export function freezeSubagentGroups(active: ActiveTurn): void {
	for (const line of active.lines) {
		if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
		for (const member of line.members) {
			if (member.status === "running") {
				member.status = active.outcome === "done" ? "done" : "failed";
				member.durationMs = Date.now() - line.startedAt;
				if (member.status === "failed") member.failure = "the subagent never reported back";
			}
		}
		line.durationMs = Date.now() - line.startedAt;
	}
}


/** 把活动回合里新追加的行同步到对话流；只追加，避免每个 token 都复制整份历史。 */
export function syncTurn(host: TuiHost, active: ActiveTurn): void {
	const response = active.turn.response;
	for (let index = response.length; index < active.lines.length; index += 1) {
		response.push(active.lines[index]!);
	}
	host.markTranscriptDirty();
}

/** 工具行被换成组对象时，另一份数组里的引用也要整体替换。 */
export function syncTurnFull(host: TuiHost, active: ActiveTurn): void {
	const response = active.turn.response;
	response.length = 0;
	response.push(...active.lines);
	host.markTranscriptDirty();
}

export function appendLine(host: TuiHost, active: ActiveTurn, line: TranscriptLine): void {
	closeText(active);
	active.lines.push(line);
	syncTurn(host, active);
}
