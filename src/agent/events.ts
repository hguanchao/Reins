import type { LlmStopReason } from "../llm/messages.ts";

/**
 * 这一轮是被谁停下的。
 *
 * 中止原因要随事件一路带到界面：只有「使用者按下中断」和「会话关闭」两种会被主动标记，
 * 拿不到标记时按未知处理——把未知说成「你停的」是在替使用者编造事实。
 */
export type AbortCause = "user" | "session";

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
	/** 模型开始写一次工具调用；参数还在流式传输，工具尚未执行 */
	| { readonly type: "writing_tool_call"; readonly name: string }
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
			/** 结果的第一行。失败时它就是失败原因，界面据此告诉使用者为什么没做成。 */
			readonly summary: string;
			/** 结果全文；界面展开细节用它，不带时界面只能看到 summary。 */
			readonly content?: string;
			/** 工具返回的结构化结果；界面据此生成折叠行指标，不发给模型 */
			readonly details?: unknown;
	  }
	/** 一轮结束；stopReason 说明为什么停 */
	| { readonly type: "turn_end"; readonly stopReason: LlmStopReason }
	/** 一笔用量已经落进会话；界面据此更新统计，不必等整轮结束 */
	| {
			readonly type: "usage_recorded";
			/** 这笔用量来自主对话回合还是上下文压缩 */
			readonly kind: "turn" | "compact";
			/** 本次请求的合计 token 数（输入 + 输出，含缓存） */
			readonly tokens: number;
	  }
	/** 请求失败后正在重试：此时还没有新的内容，界面据此说明为什么还在等 */
	| {
			readonly type: "retrying";
			readonly attempt: number;
			/** 最多重试几次；有上限才知道还要等多久 */
			readonly maxAttempts: number;
			/** 一句人话，不是上游的原始报文 */
			readonly reason: string;
	  }
	/** 上下文太长，开始把前面一段换成摘要 */
	| {
			readonly type: "compaction_start";
			/** 要摘要掉的消息条数 */
			readonly messages: number;
			readonly tokensBefore: number;
	  }
	/** 摘要已经写进会话，后续请求用的是压缩后的上下文 */
	| {
			readonly type: "compaction_end";
			readonly covered: number;
			readonly tokensBefore: number;
			readonly tokensAfter: number;
	  }
	/** 压缩没有成功：接下来的请求仍带着完整上下文 */
	| { readonly type: "compaction_failed"; readonly message: string }
	/** 手动压缩时没有可压缩的部分：上下文本来就短，保持不变 */
	| { readonly type: "compaction_skipped"; readonly message: string }
	/** 一句与这一轮无关但要让人看见的提示，比如配置刚被重新读取 */
	| { readonly type: "notice"; readonly message: string }
	/** 模型返回出错或连接中断。整个回合到此为止。 */
	| { readonly type: "error"; readonly message: string }
	/** 用户中止 */
	| { readonly type: "aborted"; readonly cause?: AbortCause }
	/** 本次运行彻底结束，此后不会再有事件 */
	| { readonly type: "run_end" };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
