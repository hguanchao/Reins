import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModelReviewer, parseVerdict } from "../../src/permission/reviewer.ts";
import { ScriptedClient, errorResult, textResult } from "../agent/scripted-client.ts";

const signal = new AbortController().signal;

function reviewer(script: Parameters<typeof ScriptedClient.prototype.stream> extends never ? never : ConstructorParameters<typeof ScriptedClient>[0]) {
	const client = new ScriptedClient(script);
	return {
		client,
		instance: new ModelReviewer({
			client,
			model: "judge-model",
			maxTokens: 1024,
			workspaceRoot: "/work",
		}),
	};
}

describe("审查结论的解析", () => {
	it("直接给出 JSON", () => {
		assert.deepEqual(parseVerdict('{"allow": true, "reason": "只读操作"}'), {
			allowed: true,
			reason: "只读操作",
		});
	});

	it("JSON 被包在说明文字或代码围栏里也能取出来", () => {
		assert.deepEqual(
			parseVerdict('判断如下：\n```json\n{"allow": false, "reason": "会删掉文件"}\n```'),
			{ allowed: false, reason: "会删掉文件" },
		);
	});

	it("缺理由时补一句而不是当失败", () => {
		assert.deepEqual(parseVerdict('{"allow": true}'), { allowed: true, reason: "审查模型未给出理由" });
	});

	it("解析不出来时按拒绝处理", () => {
		for (const text of ["", "我认为可以放行", '{"verdict": "yes"}', "[1,2,3]"]) {
			const outcome = parseVerdict(text);
			assert.equal(outcome.allowed, false, text);
			assert.match(outcome.reason, /无法解析/);
		}
	});
});

describe("审查模型", () => {
	it("放行的结论原样带回", async () => {
		const { instance, client } = reviewer([textResult('{"allow": true, "reason": "只改工作区内的文件"}')]);
		const outcome = await instance.review("write", { path: "a.txt" }, signal);

		assert.deepEqual(outcome, { allowed: true, reason: "只改工作区内的文件" });
		// 审查请求里带着工作区与调用内容，否则判断不了「工作区之外」
		const sent = client.requests[0];
		assert.ok(sent.system.includes("拿不准就拒绝"));
		const userText = sent.messages[0];
		assert.equal(userText.role, "user");
		assert.match(userText.role === "user" ? userText.content : "", /\/work/);
		assert.match(userText.role === "user" ? userText.content : "", /a\.txt/);
		assert.equal(sent.tools.length, 0);
		assert.equal(sent.effort, undefined);
	});

	it("审查过程出错时按拒绝处理", async () => {
		const { instance } = reviewer([errorResult("额度不足")]);
		const outcome = await instance.review("bash", { command: "rm -rf /" }, signal);
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /审查未能完成/);
		assert.match(outcome.reason, /额度不足/);
	});

	it("结论读不懂时按拒绝处理", async () => {
		const { instance } = reviewer([textResult("我觉得应该没问题吧")]);
		const outcome = await instance.review("bash", {}, signal);
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /无法解析/);
	});
});
