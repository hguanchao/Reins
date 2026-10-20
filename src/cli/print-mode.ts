import type { TurnDriver } from "../agent/driver.ts";
import type { AgentEvent, AgentEventListener } from "../agent/events.ts";
import { describeToolCall, displayToolName } from "../tools/describe.ts";

/**
 * 非交互模式。
 *
 * 标准输出只放模型的回答，过程中的工具调用等信息一律走标准错误：这样 `reins 做某事 > 文件`
 * 拿到的就是干净的答案，而人在终端上仍能看到它在做什么。
 *
 * 退出码按结果给：出错或中止为 1，正常结束为 0。脚本据此判断成败，比去 grep 输出可靠。
 */

export interface PrintModeDeps {
	readonly prompt: string;
	/** 装配处交进来的构造方式：事件监听由本模式提供，驱动本身由装配处组装 */
	readonly createDriver: (onEvent: AgentEventListener) => Pick<TurnDriver, "run">;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
}

export async function runPrintMode(deps: PrintModeDeps): Promise<number> {
	const state = { failed: false, wroteText: false, finished: false };

	const listener: AgentEventListener = (event: AgentEvent): void => {
		switch (event.type) {
			case "text_delta":
				deps.stdout(event.text);
				state.wroteText = true;
				return;
			case "tool_start": {
				const described = describeToolCall(event.name, event.args);
				const detail = described.detail.length === 0 ? "" : `  ${described.detail}`;
				deps.stderr(`\n› ${described.name}${detail}\n`);
				return;
			}
			case "tool_end":
				// 成功不落行；失败要把原因说出来，否则使用者只知道「没做成」，不知道该改什么
				if (event.isError) {
					deps.stderr(
						`  × ${displayToolName(event.name)}  ${event.summary} (${event.durationMs}ms)\n`,
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
				deps.stderr(`\n· retrying (${event.attempt}): ${event.reason}\n`);
				return;
			case "error":
				deps.stderr(`\n× Error: ${event.message}\n`);
				state.failed = true;
				return;
			case "aborted":
				deps.stderr("\n× Error: aborted\n");
				state.failed = true;
				return;
			default:
				// 推理内容、工具阶段性输出与阶段信号在非交互模式下不显示：
				// 它们是给实时界面用的，打到标准输出会污染答案
				return;
		}
	};

	const controller = new AbortController();
	const onInterrupt = (): void => controller.abort();
	process.on("SIGINT", onInterrupt);

	try {
		await deps.createDriver(listener).run(deps.prompt, controller.signal);
	} catch (error) {
		deps.stderr(`\n× Error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		process.removeListener("SIGINT", onInterrupt);
		if (state.wroteText) deps.stdout("\n");
	}

	return state.failed || !state.finished ? 1 : 0;
}
