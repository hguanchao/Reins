import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Compactor, estimateTokens } from "../../src/agent/compactor.ts";
import type { ModelEntry } from "../../src/config/providers-file.ts";
import type { LlmMessage } from "../../src/llm/messages.ts";
import { ScriptedClient, errorResult, textResult } from "./scripted-client.ts";

/**
 * 上下文压缩的判断与摘要请求。
 *
 * 这几条规则决定「什么时候压、压掉哪一段」：判断错了要么永远不压（最后被端点拒绝），要么
 * 把不该丢的上下文丢掉。摘要请求本身也要守规矩——它不该带工具，也不该要思考等级。
 */

const model: ModelEntry = {
	id: "compact-model",
	name: "压缩模型",
	api: "scripted",
	baseUrl: "https://x",
	reasoning: true,
	thinkingLevelMap: {},
	input: ["text"],
	cost: undefined,
	contextWindow: 1000,
	maxTokens: 512,
	headers: {},
};

function makeCompactor(client: ScriptedClient, contextWindow = 1000): Compactor {
	return new Compactor({ client, provider: "p", model, contextWindow, maxTokens: 4096 });
}

function user(text: string): LlmMessage {
	return { role: "user", content: text };
}

function assistantText(text: string): LlmMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantCall(id: string): LlmMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.txt" } }] };
}

function toolResult(id: string, content: string): LlmMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false };
}

describe("压缩的时机", () => {
	it("上下文到上限的八成才压，留出余量给这一轮的输出", () => {
		const compactor = makeCompactor(new ScriptedClient([]));
		assert.equal(compactor.shouldCompact(799), false);
		assert.equal(compactor.shouldCompact(800), true);
	});
});

describe("压缩的范围", () => {
	it("保留最近的内容，全部都在保留额度里时不压", () => {
		const compactor = makeCompactor(new ScriptedClient([]));
		assert.equal(compactor.plan([user("短"), assistantText("也短")]), 0);
	});

	it("边界不落在工具结果上：它对应的调用被摘要掉，端点会拒绝整个请求", () => {
		// 保留额度 225：最近两条（那条大消息 + 收尾）正好放得下，再往前就超了
		const compactor = makeCompactor(new ScriptedClient([]), 900);
		const boundaryIsToolResult = [
			user("开始"),
			assistantCall("c1"),
			toolResult("c1", "字".repeat(200)),
			assistantText("收尾"),
		];
		// 边界原本落在工具结果上，因此往前挪一条，把那次调用一起留下
		assert.equal(compactor.plan(boundaryIsToolResult), 1);

		// 同样的大小，但边界那条是使用者说的话时就不必挪
		const boundaryIsUser = [
			user("开始"),
			assistantCall("c1"),
			user("字".repeat(200)),
			assistantText("收尾"),
		];
		assert.equal(compactor.plan(boundaryIsUser), 2);
	});
});

describe("摘要请求", () => {
	const signal = new AbortController().signal;

	it("带上指令、不带工具，也不发思考等级", async () => {
		const client = new ScriptedClient([textResult("摘要正文")]);
		const result = await makeCompactor(client).summarize([user("甲"), assistantText("乙")], signal);

		assert.equal(result.ok, true);
		const request = client.requests[0];
		assert.equal(request.model, "compact-model");
		assert.deepEqual(request.tools, []);
		assert.equal(request.effort, undefined);
		assert.equal(request.maxTokens, 512);
		assert.match(request.system, /交接/);
		const last = request.messages[request.messages.length - 1];
		assert.equal(last.role, "user");
		if (last.role === "user") assert.match(last.content, /压缩/);
	});

	it("摘要与用量一起交回", async () => {
		const client = new ScriptedClient([textResult("  摘要正文  ")]);
		const result = await makeCompactor(client).summarize([user("甲")], signal);

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.summary, "摘要正文");
			assert.equal(result.usage?.total, 15);
		}
	});

	it("端点出错时如实回报，不拿半截摘要替换历史", async () => {
		const client = new ScriptedClient([errorResult("连接断了")]);
		const result = await makeCompactor(client).summarize([user("甲")], signal);

		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /连接断了/);
	});

	it("输出被上限截断、以及没有内容时都不采用", async () => {
		const truncated = { ...textResult("写到一半"), stopReason: "length" as const };
		const cut = await makeCompactor(new ScriptedClient([truncated])).summarize([user("甲")], signal);
		assert.equal(cut.ok, false);
		if (!cut.ok) assert.match(cut.message, /截断/);

		const empty = await makeCompactor(new ScriptedClient([textResult("   ")])).summarize([user("甲")], signal);
		assert.equal(empty.ok, false);
		if (!empty.ok) assert.match(empty.message, /没有返回任何内容/);
	});
});

describe("上下文规模的估算", () => {
	it("中文比同长度的拉丁文占得更多，规模随内容增长", () => {
		const chinese = estimateTokens([user("字".repeat(100))]);
		const latin = estimateTokens([user("a".repeat(100))]);
		assert.ok(chinese > latin, `中文 ${chinese} 应当大于拉丁文 ${latin}`);
		assert.ok(estimateTokens([user("字".repeat(200))]) > chinese);
	});

	it("工具的调用与结果都算进去", () => {
		const withoutTools = estimateTokens([user("甲")]);
		const withTools = estimateTokens([assistantCall("c1"), toolResult("c1", "读到的内容")]);
		assert.ok(withTools > withoutTools);
	});
});
