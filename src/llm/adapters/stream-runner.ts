import type { LlmEvent, LlmRequest, LlmResult, LlmStream } from "../client.ts";
import { EventStream } from "../event-stream.ts";

/**
 * 把「异步产出增量、最后给出结果」的过程包装成 LlmStream。
 *
 * 过程里抛出的任何异常都转成 stopReason 为 error 或 aborted 的结果。这是契约的一部分：
 * 调用方拿到事件流之后，只按 stopReason 分支就够了，不必再套一层捕获。
 */
export function createLlmStream(
	request: LlmRequest,
	run: (emit: (event: LlmEvent) => void) => Promise<LlmResult>,
): LlmStream {
	const stream = EventStream.incremental<LlmEvent, LlmResult>();
	void (async () => {
		try {
			stream.close(await run((event) => stream.push(event)));
		} catch (error) {
			stream.close(failedResult(request, error));
		}
	})();
	return stream;
}

/** 请求过程中的失败统一收敛成这个结果。 */
export function failedResult(request: LlmRequest, error: unknown): LlmResult {
	return {
		content: [],
		usage: undefined,
		stopReason: request.signal.aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		model: request.model,
	};
}

/** 拼出请求地址。baseUrl 约定是接口根（含版本段），这里只补路径。 */
export function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
