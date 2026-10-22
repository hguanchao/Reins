import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeFailure } from "../../src/llm/failure.ts";

describe("上游失败的翻译", () => {
	it("按状态码给一句概括", () => {
		assert.equal(describeFailure("HTTP 429"), "Rate limited");
		assert.equal(describeFailure("HTTP 401"), "Request denied");
		assert.equal(describeFailure("HTTP 404"), "Not found");
		assert.equal(describeFailure("HTTP 504"), "Request timed out");
		assert.equal(describeFailure("HTTP 413"), "Request too large");
	});

	it("服务器故障丢掉响应体：里面只有内部错误码，没有信息量", () => {
		const raw = 'HTTP 503 {"error":{"code":null,"message":"upstream overloaded"}}';

		assert.equal(describeFailure(raw), "Service unavailable");
	});

	it("客户端错误保留服务端说的那句话", () => {
		assert.equal(
			describeFailure('HTTP 400 {"error":{"message":"temperature must be <= 2"}}'),
			"Bad request · temperature must be <= 2",
		);
		assert.equal(
			describeFailure('HTTP 404 {"message":"model not found"}'),
			"Not found · model not found",
		);
	});

	it("响应体不是 JSON 时退回原文并截短", () => {
		assert.equal(describeFailure("HTTP 429 slow down"), "Rate limited · slow down");
	});

	it("认不出的状态码原样返回，不硬编一句可能更误导的话", () => {
		assert.equal(describeFailure("HTTP 418 teapot"), "HTTP 418 teapot");
	});

	it("不是 HTTP 失败时原样返回", () => {
		assert.equal(describeFailure("connection reset"), "connection reset");
	});

	it("附注过长时截断，别把状态行撑爆", () => {
		const long = "x".repeat(200);
		const described = describeFailure(`HTTP 400 ${long}`);

		assert.ok(described.startsWith("Bad request · "));
		assert.ok(described.length <= "Bad request · ".length + 80);
		assert.ok(described.endsWith("…"));
	});
});
