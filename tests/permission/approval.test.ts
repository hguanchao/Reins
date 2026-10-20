import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApprovalBroker } from "../../src/permission/approval.ts";

describe("审批桥接", () => {
	it("请求排队，一次只暴露一个", async () => {
		const broker = new ApprovalBroker();

		const first = broker.request({ tool: "read", risk: "", detail: "{}" });
		assert.deepEqual(broker.pending(), { tool: "read", risk: "", detail: "{}" });

		const second = broker.request({ tool: "write", risk: "destructive", detail: "a.ts" });
		assert.deepEqual(broker.pending(), { tool: "read", risk: "", detail: "{}" });

		broker.resolve("once");
		assert.deepEqual(broker.pending(), { tool: "write", risk: "destructive", detail: "a.ts" });
		assert.equal(await first, "once");

		broker.resolve("deny");
		assert.equal(broker.pending(), undefined);
		assert.equal(await second, "deny");
	});

	it("denyAll 拒绝所有等待中的请求", async () => {
		const broker = new ApprovalBroker();

		const first = broker.request({ tool: "a", risk: "", detail: "" });
		const second = broker.request({ tool: "b", risk: "", detail: "" });
		broker.denyAll();

		assert.equal(await first, "deny");
		assert.equal(await second, "deny");
		assert.equal(broker.pending(), undefined);
	});

	it("可记住的范围随请求一起展示", async () => {
		const broker = new ApprovalBroker();
		const request = {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		};
		const answer = broker.request(request);

		assert.deepEqual(broker.pending(), request);

		broker.resolve("always");
		assert.equal(await answer, "always");
	});
});
