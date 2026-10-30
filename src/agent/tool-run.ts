import type { LlmToolCallBlock } from "#src/llm/messages.ts";
import { describeError } from "#src/shared/describe-error.ts";
import type { ToolRegistry, ToolRunContext } from "#src/tools/registry.ts";
import { TRUNCATED_TOOL_ARGUMENTS } from "#src/agent/request.ts";

/**
 * 一次模型响应的工具编排。
 *
 * 回合驱动与子代理都要做同一件事：校验参数、并行执行、把结果按原顺序写回对话、把被截断的
 * 调用标成失败。这条流程里没有隐藏状态——它只依赖工具注册表、运行上下文与两个动作：一个
 * 「怎么展示」、一个「写回哪里」。两者共用同一份实现，主对话与子代理的行为不会各走一路。
 */

/** 一次调用落回对话的结果。字段名与请求层的工具结果消息一致。 */
export interface ToolOutcome {
	readonly callId: string;
	readonly toolName: string;
	readonly content: string;
	readonly isError: boolean;
	/** 工具自己的结构化结果，只给界面用 */
	readonly details?: unknown;
}

/**
 * 执行结束后报给界面的那一份。
 *
 * executed 说的是「执行过没有」：注册表在审批前就拒绝时同样给出一条错误结果，但那一刻
 * 还没有任何界面行说要跑这个工具，凭空补一行会让使用者看到一个从没发生过的调用。
 */
export interface ToolRunEnd extends ToolOutcome {
	readonly durationMs: number;
	/** 结果的第一行 */
	readonly summary: string;
	readonly executed: boolean;
}

/** 一次工具执行在界面上的两个动作。省略表示这种输出方式不需要中间态。 */
export interface ToolRunReporting {
	/** 开始执行前 */
	readonly start?: (call: LlmToolCallBlock) => void | Promise<void>;
	/** 执行结束后 */
	readonly end?: (outcome: ToolRunEnd) => void | Promise<void>;
}

export interface ToolRunDeps {
	readonly tools: ToolRegistry;
	/** 除 onUpdate 之外的运行环境；阶段性输出统一走上面的 onUpdate */
	readonly run: Omit<ToolRunContext, "onUpdate">;
	/** 写回对话；与 end 分开，因为「展示」和「记进历史」是两件事 */
	readonly write: (outcome: ToolOutcome) => Promise<void>;
	/** 工具推送的阶段性输出；不提供时直接丢弃 */
	readonly onUpdate?: (call: LlmToolCallBlock, text: string) => void;
	/** 结果摘要的行首上限；摘要只用于界面一行显示 */
	readonly summaryLimit?: number;
	readonly reporting?: ToolRunReporting;
}

/** 摘要默认截到这么长：一行里要放得下工具名、摘要与耗时。 */
const DEFAULT_SUMMARY_LIMIT = 200;

/** 注册表在审批阶段拒绝时给出的固定前缀；界面据此判断该不该补一行。 */
const REFUSAL_PREFIX = "Not executed: ";

/**
 * 执行一次响应里的全部工具调用。
 *
 * 并行执行但不让单次调用的意外异常炸掉整批：助手消息已经带着全部调用落进会话，任何一条
 * 缺结果都会让后续请求被端点拒绝，所以异常也转成错误结果照常写回。写回顺序沿用模型给出的
 * 顺序——并行改变的是完成次序，不是对话里的次序。
 */
export async function runToolCalls(
	calls: readonly LlmToolCallBlock[],
	deps: ToolRunDeps,
): Promise<void> {
	if (calls.length === 0) return;
	const settled = await Promise.allSettled(calls.map((call) => runOne(call, deps)));
	const outcomes = settled.map((entry, index) =>
		entry.status === "fulfilled" ? entry.value : internalFailure(calls[index], entry.reason),
	);
	for (const outcome of outcomes) await deps.write(outcome);
}

/**
 * 执行一次响应里的全部工具调用，但都不真的执行。
 *
 * 输出被长度上限截断时，流式收到的参数可能只是前半截。拿去做执行是危险的：一个被截断的
 * 路径或命令可能指向完全不同的东西。调用行仍要发出去，否则使用者只看到这一轮突然停下。
 */
export async function rejectToolCalls(
	calls: readonly LlmToolCallBlock[],
	deps: ToolRunDeps,
	content: string = TRUNCATED_TOOL_ARGUMENTS,
): Promise<void> {
	for (const call of calls) {
		if (deps.reporting?.start !== undefined) await deps.reporting.start(call);
		const outcome: ToolOutcome = {
			callId: call.id,
			toolName: call.name,
			content,
			isError: true,
		};
		await report(deps, { ...outcome, durationMs: 0, summary: firstLineOf(content), executed: false });
		await deps.write(outcome);
	}
}

async function runOne(call: LlmToolCallBlock, deps: ToolRunDeps): Promise<ToolOutcome> {
	// 参数不是合法 JSON 时不能拿空对象去执行：那等于替使用者猜了一个调用。
	// 但调用行仍要发出去：不发的话界面上只会看到这一轮突然停下，使用者无从判断
	// 是模型说完了还是调用失败了。
	if (call.argumentsError !== undefined) {
		if (deps.reporting?.start !== undefined) await deps.reporting.start(call);
		const outcome: ToolOutcome = {
			callId: call.id,
			toolName: call.name,
			content: call.argumentsError,
			isError: true,
		};
		await report(deps, { ...outcome, durationMs: 0, summary: firstLineOf(call.argumentsError), executed: true });
		return outcome;
	}

	if (deps.reporting?.start !== undefined) await deps.reporting.start(call);
	const result = await deps.tools.call(
		{ callId: call.id, name: call.name, args: call.arguments },
		{
			...deps.run,
			// 阶段性输出只是给界面看的，不参与对话内容；监听者出错也不该拖垮整个进程
			onUpdate: (text) => deps.onUpdate?.(call, text),
		},
	);

	const outcome: ToolOutcome = {
		callId: call.id,
		toolName: call.name,
		content: result.content,
		isError: result.isError,
	};
	await report(deps, {
		...outcome,
		durationMs: result.durationMs,
		summary: firstLineOf(result.content),
		executed: !result.content.startsWith(REFUSAL_PREFIX),
		...(result.details === undefined ? {} : { details: result.details }),
	});
	return outcome;
}

async function report(deps: ToolRunDeps, outcome: ToolRunEnd): Promise<void> {
	if (deps.reporting?.end !== undefined) await deps.reporting.end(outcome);
}

/** 单次调用的意外异常：转成错误结果照常写回，否则后续每个请求都会缺一条对应结果。 */
function internalFailure(
	call: LlmToolCallBlock | undefined,
	reason: unknown,
): ToolOutcome {
	return {
		callId: call?.id ?? "",
		toolName: call?.name ?? "",
		content: `Internal error while running the tool: ${describeError(reason)}`,
		isError: true,
	};
}

/**
 * 结果的第一行作摘要。
 *
 * 与界面折叠行的取值规则一致：摘要是给人扫一眼的，整段结果原样交给模型，不再经手截取。
 */
function firstLineOf(content: string): string {
	const line = content.split("\n", 1)[0] ?? "";
	return line.length > DEFAULT_SUMMARY_LIMIT ? `${line.slice(0, DEFAULT_SUMMARY_LIMIT)}…` : line;
}
