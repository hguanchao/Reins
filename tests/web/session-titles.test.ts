import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "#web/protocol.ts";
import { putSessionTitle, readSessionTitles, withSessionTitles } from "#web/state/session-titles.ts";

const sessions: readonly SessionSummary[] = [
	{ id: "a", title: "修复登录", updatedAt: "2026-11-04T10:00:00.000Z" },
	{ id: "b", title: undefined, updatedAt: "2026-11-04T09:00:00.000Z" },
];

describe("任务显示名覆盖", () => {
	it("覆盖优先于服务端标题，未覆盖的保持原样", () => {
		const merged = withSessionTitles(sessions, { a: "登录重构" });
		assert.equal(merged[0]?.title, "登录重构");
		assert.equal(merged[1]?.title, undefined);
	});

	it("没有任何覆盖时原样返回同一份列表", () => {
		assert.equal(withSessionTitles(sessions, {}), sessions);
	});

	it("写入覆盖返回新表；空名字撤销覆盖", () => {
		const next = putSessionTitle({ a: "旧名" }, "b", "  新任务  ");
		assert.deepEqual(next, { a: "旧名", b: "新任务" });
		const cleared = putSessionTitle(next, "a", "   ");
		assert.deepEqual(cleared, { b: "新任务" });
	});

	it("存储不可用时读取当作没有改过名", () => {
		// node 测试环境没有 localStorage：读回来必须是空表而不是抛错
		assert.deepEqual(readSessionTitles(), {});
	});
});
