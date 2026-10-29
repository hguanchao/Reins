import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hostOf, webFetchTool } from "../../../src/tools/builtin/web-fetch.ts";
import { validateToolArguments } from "../../../src/tools/schema.ts";

/** 工具定义的静态契约；抓取行为本身在 tests/tools/web-fetch.test.ts 覆盖。 */

describe("web_fetch 工具定义", () => {
	it("标注为只读且触网", () => {
		assert.equal(webFetchTool.name, "web_fetch");
		assert.deepEqual(webFetchTool.annotations, { readOnly: true, destructive: false, openWorld: true });
	});

	it("参数模式：url 必填、多给与少给都拒绝", () => {
		assert.equal(validateToolArguments(webFetchTool.parameters, { url: "https://example.com" }).ok, true);
		assert.equal(validateToolArguments(webFetchTool.parameters, {}).ok, false);
		assert.equal(validateToolArguments(webFetchTool.parameters, { url: "https://a.com", extra: 1 }).ok, false);
	});

	it("审批范围按主机记忆", () => {
		const scope = webFetchTool.permissionScope?.({ url: "https://example.com/docs/a" }, undefined as never);
		assert.equal(scope?.key, "web_fetch:example.com");
		assert.ok(scope?.label.includes("example.com"));
	});

	it("解不出主机名时不给可记忆的范围", () => {
		assert.equal(webFetchTool.permissionScope?.({ url: "not a url" }, undefined as never), undefined);
		assert.equal(webFetchTool.permissionScope?.({ url: "" }, undefined as never), undefined);
	});

	it("拒绝执行非 http(s) 的调用", async () => {
		const outcome = await webFetchTool.execute({
			callId: "t",
			args: { url: "ftp://example.com/file" },
			signal: new AbortController().signal,
			onUpdate: () => {},
			workspace: undefined as never,
			sandbox: undefined as never,
			session: undefined as never,
		});
		assert.equal(outcome.isError, true);
		assert.ok(outcome.content.includes("Not fetched"));
	});

	it("主机名提取：正常地址取主机名，垃圾输入返回 undefined", () => {
		assert.equal(hostOf("https://example.com/a"), "example.com");
		assert.equal(hostOf("not a url"), undefined);
	});
});
