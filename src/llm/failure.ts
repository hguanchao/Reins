/**
 * 把上游失败翻译成一句人话。
 *
 * 原始报文长这样：`HTTP 503 {"error":{"code":null,"message":"..."}}`。整段贴到状态行上，既
 * 读不懂，也读不出该做什么。
 *
 * 两条规则：服务器故障（5xx）不保留响应体——里面通常只有内部错误码，对使用者没有信息量，
 * 说清「服务不可用，等一下再发」就够了；客户端错误（4xx）相反，服务端往往在 message 里
 * 指明了是哪个参数不对，留着有用。
 */

/** 附注最多这么长：它要挤在状态行里，还得给重试次数留位置。 */
const DETAIL_LIMIT = 80;

const HTTP_PREFIX = /^HTTP (\d{3})(?:\s+([\s\S]*))?$/;

/**
 * 认得出的失败返回「概括 · 附注」，认不出的原样返回——调用方自己决定怎么截断。
 */
export function describeFailure(raw: string): string {
	const match = HTTP_PREFIX.exec(raw.trim());
	if (match === null) return raw;

	const status = Number(match[1]);
	const headline = headlineFor(status);
	if (headline === undefined) return raw;

	const detail = status >= 500 ? "" : extractMessage(match[2]?.trim() ?? "");
	return detail.length === 0 ? headline : `${headline} · ${detail}`;
}

function headlineFor(status: number): string | undefined {
	if (status === 400 || status === 422) return "Bad request";
	if (status === 401 || status === 403) return "Request denied";
	if (status === 404) return "Not found";
	if (status === 408 || status === 504) return "Request timed out";
	if (status === 409) return "Conflict";
	if (status === 413) return "Request too large";
	if (status === 429) return "Rate limited";
	if (status >= 500) return "Service unavailable";
	return undefined;
}

function extractMessage(body: string): string {
	if (body.length === 0) return "";
	const message = messageFromJson(body);
	// 不是 JSON 就退回原文：它可能是网关返回的一整页 HTML，截短后至少能看出是什么
	return message ?? truncate(body);
}

/** 两种常见形状：`{"error":{"message":"…"}}` 与 `{"message":"…"}`。 */
function messageFromJson(body: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;

	const record = parsed as Record<string, unknown>;
	const error = record["error"];
	if (typeof error === "string" && error.trim().length > 0) return truncate(error.trim());
	if (typeof error === "object" && error !== null) {
		const nested = (error as Record<string, unknown>)["message"];
		if (typeof nested === "string" && nested.trim().length > 0) return truncate(nested.trim());
	}
	const message = record["message"];
	return typeof message === "string" && message.trim().length > 0 ? truncate(message.trim()) : undefined;
}

function truncate(text: string): string {
	const clean = text.replaceAll(/\s+/g, " ").trim();
	return clean.length > DETAIL_LIMIT ? `${clean.slice(0, DETAIL_LIMIT - 1)}…` : clean;
}
