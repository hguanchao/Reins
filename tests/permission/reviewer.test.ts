import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModelReviewer, parseVerdict } from "../../src/permission/reviewer.ts";
import { EventStream } from "../../src/llm/event-stream.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../../src/llm/client.ts";

/** 不发真实请求的假客户端：返回预置的最终文本。 */
function fakeStream(text: string, stopReason: LlmResult["stopReason"] = "stop"): LlmStream {
	const stream = EventStream.incremental<LlmEvent, LlmResult>();
	stream.push({ type: "text_delta", text });
	stream.close({
		stopReason,
		content: [{ type: "text", text }],
		usage: undefined,
		errorMessage: undefined,
		model: "m",
	});
	return stream;
}

function clientReturning(text: string, stopReason: LlmResult["stopReason"] = "stop"): LlmClient {
	return {
		api: "fake",
		stream: (_request: LlmRequest) => fakeStream(text, stopReason),
	};
}

const SIGNAL = new AbortController().signal;

describe("审查结论解析", () => {
	it("纯 JSON 直接解析", () => {
		assert.deepEqual(parseVerdict('{"allow": true, "reason": "read only"}'), {
			allowed: true,
			reason: "read only",
		});
		assert.deepEqual(parseVerdict('{"allow": false, "reason": "deletes history"}'), {
			allowed: false,
			reason: "deletes history",
		});
	});

	it("JSON 包在说明文字或代码围栏里也能取出来", () => {
		const fenced = 'Here is my verdict:\n```json\n{"allow": true, "reason": "harmless"}\n```';
		assert.deepEqual(parseVerdict(fenced), { allowed: true, reason: "harmless" });
	});

	it("缺 reason 时给出默认说法", () => {
		assert.deepEqual(parseVerdict('{"allow": true}'), { allowed: true, reason: "Reviewer gave no reason" });
	});

	it("解析不出来的按拒绝处理", () => {
		assert.equal(parseVerdict("no json here").allowed, false);
		assert.equal(parseVerdict("").allowed, false);
		assert.equal(parseVerdict('{"allow": "yes"}').allowed, false);
		assert.equal(parseVerdict("{}").allowed, false);
	});
});

describe("模型审查者", () => {
	it("把工作区与调用放进请求，采纳模型的结论", async () => {
		let captured: LlmRequest | undefined;
		const client: LlmClient = {
			api: "fake",
			stream: (request: LlmRequest) => {
				captured = request;
				return fakeStream('{"allow": true, "reason": "fine"}');
			},
		};
		const reviewer = new ModelReviewer({ client, model: "m1", maxTokens: undefined, workspaceRoot: "E:\\w" });
		const outcome = await reviewer.review("write", { path: "a.ts" }, SIGNAL);
		assert.deepEqual(outcome, { allowed: true, reason: "fine" });
		assert.ok(captured);
		assert.equal(captured.model, "m1");
		assert.match(captured.messages[0]!.content as string, /Workspace: E:\\w/);
		assert.match(captured.messages[0]!.content as string, /Tool: write/);
	});

	it("审查没能完成时按拒绝处理", async () => {
		const client = clientReturning("ignored", "error");
		const reviewer = new ModelReviewer({ client, model: "m", maxTokens: undefined, workspaceRoot: "/" });
		const outcome = await reviewer.review("bash", {}, SIGNAL);
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /Review did not finish/);
	});

	it("客户端抛错同样按拒绝处理", async () => {
		const client: LlmClient = {
			api: "fake",
			stream: () => {
				throw new Error("network down");
			},
		};
		const reviewer = new ModelReviewer({ client, model: "m", maxTokens: undefined, workspaceRoot: "/" });
		const outcome = await reviewer.review("bash", {}, SIGNAL);
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /network down/);
	});

	it("超长参数截断后再发", async () => {
		let captured: LlmRequest | undefined;
		const client: LlmClient = {
			api: "fake",
			stream: (request: LlmRequest) => {
				captured = request;
				return fakeStream('{"allow": false, "reason": "r"}');
			},
		};
		const reviewer = new ModelReviewer({ client, model: "m", maxTokens: undefined, workspaceRoot: "/" });
		await reviewer.review("read", { blob: "x".repeat(9000) }, SIGNAL);
		const content = (captured?.messages[0]?.content as string) ?? "";
		assert.ok(content.length < 5000);
		assert.ok(content.includes("…"));
	});
});
