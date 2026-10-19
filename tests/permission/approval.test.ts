import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApprovalBroker } from "../../src/permission/approval.ts";

describe("审批桥接", () => {
	it("请求排队，一次只暴露一个", async () => {
		const broker = new ApprovalBroker();

		const first = broker.request("Allow read?", "{}");
		assert.deepEqual(broker.pending(), { question: "Allow read?", detail: "{}" });

		const second = broker.request("Allow write?", "{}");
		assert.deepEqual(broker.pending(), { question: "Allow read?", detail: "{}" });

		broker.resolve(true);
		assert.deepEqual(broker.pending(), { question: "Allow write?", detail: "{}" });
		assert.equal(await first, true);

		broker.resolve(false);
		assert.equal(broker.pending(), undefined);
		assert.equal(await second, false);
	});

	it("denyAll 拒绝所有等待中的请求", async () => {
		const broker = new ApprovalBroker();

		const first = broker.request("a", "");
		const second = broker.request("b", "");
		broker.denyAll();

		assert.equal(await first, false);
		assert.equal(await second, false);
		assert.equal(broker.pending(), undefined);
	});
});
