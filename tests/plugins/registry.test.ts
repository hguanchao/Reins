import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { builtinSandboxBackends, builtinSessionStore } from "../../src/plugins/registry.ts";

/**
 * 内置能力的装配。
 *
 * 这几项是「产品不依赖插件也能完整工作」的落点：默认全部装好，插件随后注册同标识的实现
 * 即可替换。这里只验证清单本身——替换语义由插件宿主的用例覆盖。
 */
describe("内置能力", () => {
	it("默认带两个沙箱后端，顺序即候选顺序", () => {
		const backends = builtinSandboxBackends();
		assert.deepEqual(backends.map((backend) => backend.id), ["seatbelt", "bubblewrap"]);
	});

	it("每次调用给出新实例，互不共享状态", () => {
		assert.notEqual(builtinSandboxBackends()[0], builtinSandboxBackends()[0]);
		assert.notEqual(builtinSessionStore(), builtinSessionStore());
	});

	it("默认会话存储可用", () => {
		const store = builtinSessionStore();
		assert.equal(typeof store.create, "function");
		assert.equal(typeof store.read, "function");
		assert.equal(typeof store.append, "function");
		assert.equal(typeof store.list, "function");
	});
});
