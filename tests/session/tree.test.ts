import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionEntry } from "../../src/session/port.ts";
import { leavesOf, pathTo } from "../../src/session/tree.ts";

/**
 * 条目树的查询。
 *
 * 用例里造了一棵真分叉的树：文件里通常只有一条路径，但格式允许分叉，续聊与分叉都必须按
 * id/parentId 走，而不是按行序。
 */

function message(id: string, parentId: string | null, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content },
	};
}

/**
 *   1 ── 2 ── 3
 *        └──── 4 ── 5
 */
const tree: readonly SessionEntry[] = [
	message("1", null, "甲"),
	message("2", "1", "乙"),
	message("3", "2", "丙"),
	message("4", "2", "丁"),
	message("5", "4", "戊"),
];

describe("条目树", () => {
	it("从根到目标的那条路径按父子关系取，不看写入顺序", () => {
		assert.deepEqual(pathTo(tree, "5").map((entry) => entry.id), ["1", "2", "4", "5"]);
		assert.deepEqual(pathTo(tree, "3").map((entry) => entry.id), ["1", "2", "3"]);
	});

	it("目标不在会话里时明确报错", () => {
		assert.throws(() => pathTo(tree, "9"), /没有条目 9/);
	});

	it("叶子是没有后续的条目，分叉之后会有多个", () => {
		assert.deepEqual(leavesOf(tree).map((entry) => entry.id), ["3", "5"]);
	});

	it("只有一条路径时叶子就是最后写下的那条", () => {
		const linear = [message("1", null, "甲"), message("2", "1", "乙")];
		assert.deepEqual(leavesOf(linear).map((entry) => entry.id), ["2"]);
	});

	it("空会话没有叶子", () => {
		assert.deepEqual(leavesOf([]), []);
	});
});
