import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { leavesOf, pathTo } from "../../src/session/tree.ts";
import type { SessionEntry } from "../../src/session/port.ts";

const T = "2026-01-01T00:00:00Z";

function entry(id: string, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: T, message: { role: "user", content: id } };
}

const ENTRIES: readonly SessionEntry[] = [
	entry("a", null),
	entry("b", "a"),
	entry("c", "b"),
	entry("d", "b"), // 同挂 b：分叉
];

describe("条目树", () => {
	it("pathTo 给根到目标的路径", () => {
		assert.deepEqual(pathTo(ENTRIES, "c").map((entry) => entry.id), ["a", "b", "c"]);
		assert.deepEqual(pathTo(ENTRIES, "d").map((entry) => entry.id), ["a", "b", "d"]);
		assert.deepEqual(pathTo(ENTRIES, "a").map((entry) => entry.id), ["a"]);
	});

	it("目标不存在时报错", () => {
		assert.throws(() => pathTo(ENTRIES, "zzz"), /Session has no entry zzz/);
	});

	it("叶子：被别人引用的不算", () => {
		assert.deepEqual(leavesOf(ENTRIES).map((entry) => entry.id), ["c", "d"]);
	});

	it("线性历史里叶子就是最后一条", () => {
		const linear = [entry("a", null), entry("b", "a"), entry("c", "b")];
		assert.deepEqual(leavesOf(linear).map((entry) => entry.id), ["c"]);
	});
});
