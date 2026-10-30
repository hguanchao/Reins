import { describeError } from "#src/shared/describe-error.ts";
import type { TurnDriver } from "#src/agent/driver.ts";
import type { AgentEvent, AgentEventListener } from "#src/agent/events.ts";
import { describeToolCall, displayToolName } from "#src/tools/describe.ts";
import { formatDuration } from "#src/shared/format.ts";
import { JsonStream, type JsonRunResult } from "#src/cli/json-stream.ts";

/**
 * 非交互模式。
 *
 * 两种输出形态共用同一次运行：
 *
 * - 默认把模型的回答写进标准输出，过程中的工具调用等信息一律走标准错误。这样
 *   `reins 做某事 > 文件` 拿到的就是干净的答案，而人在终端上仍能看到它在做什么。
 * - `--json` 把事件流按行写成 JSON。此时标准输出只放事件，标准错误仍留给装配阶段的
 *   提示（配置警告、沙箱说明），两者不混。
 *
 * 退出码按结果给：出错或中止为 1，正常结束为 0。脚本据此判断成败，比去 grep 输出可靠。
 */

interface PrintModeDeps {
	readonly prompt: string;
	/** 装配处交进来的构造方式：事件监听由本模式提供，驱动本身由装配处组装 */
	readonly createDriver: (onEvent: AgentEventListener) => Pick<TurnDriver, "run">;
	/** 工作根：用来剥掉命令开头多余的工作根 cd，省略时原样显示 */
	readonly workspaceRoot?: string;
	/** 事件流形态；省略时是给人看的文本 */
	readonly json?: boolean;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
}

export async function runPrintMode(deps: PrintModeDeps): Promise<number> {
	const controller = new AbortController();
	const onInterrupt = (): void => controller.abort();
	process.on("SIGINT", onInterrupt);

	try {
		if (deps.json === true) return await runJson(deps, controller.signal);
		return await runText(deps, controller.signal);
	} catch (error) {
		deps.stderr(`\n× Error: ${describeError(error)}\n`);
		return 1;
	} finally {
		process.removeListener("SIGINT", onInterrupt);
	}
}

/** 机器可读的一条流：出错也写成事件，让下游不必同时读标准错误才对得上。 */
async function runJson(deps: PrintModeDeps, signal: AbortSignal): Promise<number> {
	const stream = new JsonStream({ write: deps.stdout });
	try {
		await deps.createDriver(stream.listener()).run(deps.prompt, signal);
	} catch (error) {
		// 抛到这一层的只有装配或驱动本身的意外；仍要发出去，否则流里只剩一个没有结论的开头
		stream.handle({ type: "error", message: describeError(error) });
	}
	return exitCode(stream.result());
}

async function runText(deps: PrintModeDeps, signal: AbortSignal): Promise<number> {
	const state = { failed: false, wroteText: false, finished: false };

	const listener: AgentEventListener = (event: AgentEvent): void => {
		switch (event.type) {
			case "text_delta":
				deps.stdout(event.text);
				state.wroteText = true;
				return;
			case "tool_start": {
				const described = describeToolCall(event.name, event.args, deps.workspaceRoot);
				const detail = described.detail.length === 0 ? "" : `  ${described.detail}`;
				deps.stderr(`\n› ${described.name}${detail}\n`);
				return;
			}
			case "tool_end":
				// 成功不落行；失败要把原因说出来，否则使用者只知道「没做成」，不知道该改什么
				if (event.isError) {
					deps.stderr(
						`  × ${displayToolName(event.name)}  ${event.summary} (${formatDuration(event.durationMs)})\n`,
					);
				}
				return;
			case "turn_end":
				state.finished = true;
				return;
			case "compaction_start":
				deps.stderr(`\n· compacting context: replacing the first ${event.messages} messages with a summary (~${event.tokensBefore} tokens)\n`);
				return;
			case "compaction_end":
				deps.stderr(`  done: ~${event.tokensBefore} → ${event.tokensAfter} tokens\n`);
				return;
			case "compaction_failed":
				deps.stderr(`\n× Error: compaction failed, continuing with the context as is: ${event.message}\n`);
				return;
			case "retrying":
				deps.stderr(`\n· retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}\n`);
				return;
			case "error":
				deps.stderr(`\n× Error: ${event.message}\n`);
				state.failed = true;
				return;
			case "aborted":
				// 中断是使用者主动停下，不是错误；退出码仍为非零，脚本据此判断这一轮没跑完
				deps.stderr("\n· stopped by you\n");
				state.failed = true;
				return;
			default:
				// 推理内容、工具阶段性输出与阶段信号在非交互模式下不显示：
				// 它们是给实时界面用的，打到标准输出会污染答案
				return;
		}
	};

	try {
		await deps.createDriver(listener).run(deps.prompt, signal);
	} finally {
		if (state.wroteText) deps.stdout("\n");
	}
	return exitCode({ failed: state.failed, finished: state.finished, error: undefined });
}

/** 两种输出形态的退出码只有这一处判断：中止与出错都是一次没跑完的运行。 */
function exitCode(outcome: JsonRunResult): number {
	return outcome.failed || !outcome.finished ? 1 : 0;
}
