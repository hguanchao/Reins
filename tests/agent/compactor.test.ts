import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compactionWindow, Compactor, estimateTokens } from "#src/agent/compactor.ts";
import { EventStream } from "#src/llm/event-stream.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "#src/llm/client.ts";
import type { LlmMessage } from "#src/llm/messages.ts";

const SIGNAL = new AbortController().signal;

function userMessage(...text: string[]): LlmMessage {
	return { role: "user", content: text.join("") };
}

function toolResultMessage(content: string): LlmMessage {
	return { role: "toolResult", toolCallId: "c", toolName: "t", content, isError: false };
}

function emptyStream(): LlmStream {
	const stream = EventStream.incremental<LlmEvent, LlmResult>();
	stream.close({ stopReason: "stop", content: [], usage: undefined, errorMessage: undefined, model: "m1" });
	return stream;
}

function compactor(overrides: Partial<{ contextWindow: number; client: LlmClient; maxTokens: number | undefined; summaryTimeoutMs: number; compactAt: number; keepRecent: number }> = {}): Compactor {
	return new Compactor({
		client: overrides.client ?? { api: "fake", stream: () => emptyStream() },
		provider: "p",
		model: { id: "m1", name: "m1", api: "a", baseUrl: "b", reasoning: false, thinkingLevelMap: {}, input: ["text"], cost: undefined, contextWindow: undefined, maxTokens: overrides.maxTokens, maxTokensField: "max_tokens", headers: {} },
		contextWindow: overrides.contextWindow ?? 1000,
		maxTokens: overrides.maxTokens,
		summaryTimeoutMs: overrides.summaryTimeoutMs,
		compactAt: overrides.compactAt,
		keepRecent: overrides.keepRecent,
	});
}

function clientSaying(text: string, stopReason: "stop" | "error" | "aborted" | "length" = "stop", errorMessage?: string): LlmClient {
	return {
		api: "fake",
		stream: (request: LlmRequest) => {
			void request;
			const es = EventStream.incremental<LlmEvent, LlmResult>();
			es.close({
				stopReason,
				content: [{ type: "text", text }],
				usage: undefined,
				errorMessage: errorMessage ?? undefined,
				model: "m1",
			});
			return es;
		},
	};
}

describe("用量估算", () => {
	it("英文字符约四字一 token,中文一字一 token", () => {
		assert.ok(estimateTokens([userMessage("x".repeat(400))]) >= 100);
		assert.ok(estimateTokens([userMessage("一二三四")]) >= 4);
	});

	it("每条消息有固定开销", () => {
		const single = estimateTokens([userMessage("x")]);
		const doubled = estimateTokens([userMessage("x"), userMessage("")]);
		assert.ok(doubled > single);
	});

	it("图片按固定开销计入,不按 base64 长度", () => {
		const withImage = estimateTokens([
			{
				role: "user",
				content: [{ type: "image", data: "A".repeat(100_000), mimeType: "image/png" }],
			},
		]);
		const empty = estimateTokens([userMessage("")]);
		assert.ok(withImage - empty >= 1200);
		assert.ok(withImage < 2000, "base64 数据本身不能按字符数计入");
	});
});

describe("压缩计划", () => {
	it("工具结果不被切在边界上", () => {
		const messages = [userMessage("old"), toolResultMessage("result"), userMessage("recent")];
		const cut = compactor().plan(messages);
		// 边界若落在 toolResult 上就往前退
		if (cut > 0) {
			assert.notEqual(messages[cut]?.role, "toolResult");
		}
	});

	it("什么都保不住时给 0", () => {
		assert.equal(compactor({ contextWindow: 10 }).plan([userMessage("x")]), 0);
	});

	it("保留比例越大，切掉的消息越少", () => {
		const messages = Array.from({ length: 6 }, (_, index) =>
			userMessage(`message ${index} ${"x".repeat(40)}`),
		);

		const small = compactor({ contextWindow: 1000, keepRecent: 0.01 }).plan(messages);
		const large = compactor({ contextWindow: 1000, keepRecent: 0.5 }).plan(messages);

		assert.ok(large < small, `keep 0.5 应保留更多：cut ${large} < ${small}`);
	});

	it("被摘要的前缀也受窗口约束：切到小窗口模型后不会整段超限", () => {
		// 只约束尾部不够：前缀若超出摘要请求自己的窗口，摘要必然失败，下一轮又重试同一段
		const messages = Array.from({ length: 20 }, (_, index) =>
			userMessage(`m${index} ${"x".repeat(400)}`),
		);
		const cut = compactor({ contextWindow: 1000, keepRecent: 0.25 }).plan(messages);

		const prefixTokens = estimateTokens(messages.slice(0, cut));
		// 前缀最多占窗口的一半（另一半留给摘要输出与系统提示）
		assert.ok(prefixTokens <= 500, `prefix tokens ${prefixTokens} 超过窗口一半`);
		assert.ok(cut >= 1, "至少要留下一条可摘要的消息");
	});
});

describe("压缩阈值", () => {
	it("默认用到八成压缩", () => {
		assert.equal(compactor({ contextWindow: 1000 }).shouldCompact(799), false);
		assert.equal(compactor({ contextWindow: 1000 }).shouldCompact(800), true);
	});

	it("阈值可调", () => {
		const early = compactor({ contextWindow: 1000, compactAt: 0.5 });
		assert.equal(early.shouldCompact(499), false);
		assert.equal(early.shouldCompact(500), true);
	});
});

describe("压缩窗口与时限", () => {
	it("摘要模型更小时按较小窗口规划", () => {
		assert.equal(compactionWindow(1000, 500), 500);
		assert.equal(compactionWindow(1000, 2000), 1000);
		assert.equal(compactionWindow(1000, undefined), 1000);
	});

	it("摘要超过总时限按失败处理", async () => {
		const client: LlmClient = {
			api: "fake",
			stream: (request: LlmRequest) => {
				const es = EventStream.incremental<LlmEvent, LlmResult>();
				request.signal.addEventListener(
					"abort",
					() => {
						es.close({
							stopReason: "aborted",
							content: [],
							usage: undefined,
							errorMessage: undefined,
							model: "m1",
						});
					},
					{ once: true },
				);
				return es;
			},
		};

		const result = await compactor({ client, summaryTimeoutMs: 10 }).summarize(
			[userMessage("content")],
			SIGNAL,
		);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.message : "", /time budget/);
	});
});

describe("摘要请求", () => {
	it("正常产出摘要", async () => {
		const client = clientSaying("the summary text");
		const result = await compactor({ client }).summarize([userMessage("content")], SIGNAL);
		assert.deepEqual(result, { ok: true, summary: "the summary text", usage: undefined, cost: undefined });
	});

	it("错误、中止、空产出都按失败处理", async () => {
		const failed = await compactor({ client: clientSaying("x", "error", "boom") }).summarize([], SIGNAL);
		assert.deepEqual(failed, { ok: false, message: "boom" });

		const aborted = await compactor({ client: clientSaying("x", "aborted") }).summarize([], SIGNAL);
		assert.deepEqual(aborted, { ok: false, message: "Compaction was aborted" });

		const empty = await compactor({ client: clientSaying(" ") }).summarize([], SIGNAL);
		assert.deepEqual(empty, { ok: false, message: "The compaction model returned nothing" });
	});

	it("截断的摘要被丢弃并给出明确理由", async () => {
		const failed = await compactor({ client: clientSaying("half summary", "length") }).summarize([], SIGNAL);
		assert.equal(failed.ok, false);
		assert.match(failed.ok === false ? failed.message : "", /output limit/);
	});

	it("请求里的注释与指令:摘要不带思考等级与工具", async () => {
		let captured: LlmRequest | undefined;
		const client: LlmClient = {
			api: "fake",
			stream: (request: LlmRequest) => {
				captured = request;
				return clientSaying("s").stream(request);
			},
		};
		await compactor({ client }).summarize([userMessage("content")], SIGNAL);
		assert.ok(captured);
		assert.equal(captured.effort, undefined);
		assert.deepEqual(captured.tools, []);
		const instruction = captured.messages[captured.messages.length - 1]!;
		assert.match(instruction.content as string, /handover summary/);
	});
});
