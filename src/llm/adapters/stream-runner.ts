import { describeError } from "../../shared/describe-error.ts";
import type { LlmEvent, LlmRequest, LlmResult, LlmStream } from "../client.ts";
import { EventStream } from "../event-stream.ts";

/**
 * 图片降级的两条占位文案，三家协议适配器共用。
 *
 * 模型不支持图片时正文里留一句说明，有图片时在正文前给一行提示：文案改这里，三个端点的
 * 表现保持一致。
 */
export const IMAGE_OMITTED_PLACEHOLDER = "(image omitted: model does not support images)";
export const IMAGE_ATTACHMENT_NOTICE = "(see attached image)";

/**
 * 把「异步产出增量、最后给出结果」的过程包装成 LlmStream。
 *
 * 过程里抛出的任何异常都转成 stopReason 为 error 或 aborted 的结果。这是契约的一部分：
 * 调用方拿到事件流之后，只按 stopReason 分支就够了，不必再套一层捕获。
 *
 * `salvage` 用来在失败时抢救已经收到的内容：连接断了不等于那段回答没发生过，界面上早就
 * 显示过了，把它交出去调用方才能决定要不要留档。
 */
export function createLlmStream(
	request: LlmRequest,
	run: (emit: (event: LlmEvent) => void) => Promise<LlmResult>,
	salvage?: () => LlmResult["content"],
): LlmStream {
	const stream = EventStream.incremental<LlmEvent, LlmResult>();
	void (async () => {
		try {
			stream.close(await run((event) => stream.push(event)));
		} catch (error) {
			stream.close(failedResult(request, error, salvage?.()));
		}
	})();
	return stream;
}

/**
 * 请求过程中的失败统一收敛成这个结果。
 *
 * `content` 是失败前已经收到的内容：连接断了不等于那段回答没发生过，界面上早就显示过了，
 * 一并交出去，调用方才能决定要不要留档。
 */
function failedResult(
	request: LlmRequest,
	error: unknown,
	content: LlmResult["content"] = [],
): LlmResult {
	return {
		content,
		usage: undefined,
		stopReason: request.signal.aborted ? "aborted" : "error",
		errorMessage: describeError(error),
		model: request.model,
	};
}

/** 拼出请求地址。baseUrl 约定是接口根（含版本段），这里只补路径。 */
export function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
