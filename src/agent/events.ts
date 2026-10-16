import type { LlmStopReason } from "../llm/messages.ts";

/**
 * 一轮对话对外发出的事件。
 *
 * 判别联合而不是回调集合：界面、日志、导出都消费同一串事件，用同一个类型描述它们，新增
 * 一种状态时编译期就能指出所有需要处理的地方。
 *
 * 消息的完整内容以会话里的记录为准，这里只发增量与阶段信号——界面据此实时显示，而历史由
 * 会话提供。
 */
export type AgentEvent =
	/** 一轮请求开始 */
	| { readonly type: "turn_start" }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "reasoning_delta"; readonly text: string }
	| {
			readonly type: "tool_start";
			readonly callId: string;
			readonly name: string;
			readonly args: Record<string, unknown>;
	  }
	| { readonly type: "tool_update"; readonly callId: string; readonly text: string }
	| {
			readonly type: "tool_end";
			readonly callId: string;
			readonly name: string;
			readonly isError: boolean;
			readonly durationMs: number;
	  }
	/** 一轮结束；stopReason 说明为什么停 */
	| { readonly type: "turn_end"; readonly stopReason: LlmStopReason }
	/** 模型返回出错或连接中断。整个回合到此为止。 */
	| { readonly type: "error"; readonly message: string }
	/** 用户中止 */
	| { readonly type: "aborted" }
	/** 本次运行彻底结束，此后不会再有事件 */
	| { readonly type: "run_end" };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
