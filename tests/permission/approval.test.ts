import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApprovalBroker } from "#src/permission/approval.ts";

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

describe("审批请求归属", () => {
	it("带上请求标识时只接受当前请求的结论", async () => {
		const broker = new ApprovalBroker();
		const answer = broker.request({ tool: "bash", risk: "", detail: "first" });

		const id = broker.pendingId();
		assert.ok(id !== undefined);
		// 旧标识不该能回答新请求
		broker.resolve("once", id + 1);
		assert.equal(broker.pendingId(), id, "标识不符时不应推进队列");
		broker.resolve("deny", id);
		assert.equal(await answer, "deny");
	});

	it("不带标识时按当前请求处理，兼容旧调用", async () => {
		const broker = new ApprovalBroker();
		const answer = broker.request({ tool: "bash", risk: "", detail: "x" });
		broker.resolve("once");
		assert.equal(await answer, "once");
	});

	it("排队请求的标识各不相同", () => {
		const broker = new ApprovalBroker();
		void broker.request({ tool: "bash", risk: "", detail: "a" });
		void broker.request({ tool: "bash", risk: "", detail: "b" });
		const first = broker.pendingId();
		broker.resolve("once");
		const second = broker.pendingId();
		assert.notEqual(first, second);
	});
});
