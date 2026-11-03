import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "#web/protocol.ts";
import { archivedFilterLabel, buildSessionRows } from "#web/shell/session-tree.ts";

const sessions: readonly SessionSummary[] = [
	{ id: "a", title: "修复登录", updatedAt: "2026-11-03T10:00:00.000Z" },
	{ id: "b", title: undefined, updatedAt: "2026-11-03T09:00:00.000Z" },
	{ id: "c", title: "写文档", updatedAt: "2026-11-03T08:00:00.000Z" },
];

const archived: readonly SessionSummary[] = [
	{ id: "z", title: "旧任务", updatedAt: "2026-10-01T09:00:00.000Z" },
];

describe("会话列表投影", () => {
	it("默认隐藏归档，置顶行提到最前，其余保持更新时间顺序", () => {
		const rows = buildSessionRows({
			sessions,
			archived,
			pinned: new Set(["c"]),
			query: "",
			archivedFilter: "hide",
		});
		assert.deepEqual(
			rows.map((row) => row.id),
			["c", "a", "b"],
		);
		assert.equal(rows[0]?.pinned, true);
		assert.equal(rows[1]?.title, "修复登录");
		assert.equal(rows[2]?.title, "新会话");
	});

	it("显示归档时把归档行接在活动会话之后并灰化", () => {
		const rows = buildSessionRows({
			sessions,
			archived,
			pinned: new Set(),
			query: "",
			archivedFilter: "show",
		});
		assert.equal(rows.length, 4);
		assert.equal(rows.at(-1)?.archived, true);
	});

	it("只看归档时活动会话不出现", () => {
		const rows = buildSessionRows({
			sessions,
			archived,
			pinned: new Set(),
			query: "",
			archivedFilter: "only",
		});
		assert.deepEqual(
			rows.map((row) => row.id),
			["z"],
		);
	});

	it("搜索忽略大小写，只匹配标题", () => {
		const rows = buildSessionRows({
			sessions,
			archived,
			pinned: new Set(),
			query: " 修复 ",
			archivedFilter: "hide",
		});
		assert.deepEqual(
			rows.map((row) => row.id),
			["a"],
		);
	});

	it("筛选文案覆盖三种状态", () => {
		assert.equal(archivedFilterLabel("hide"), "隐藏归档");
		assert.equal(archivedFilterLabel("show"), "显示归档");
		assert.equal(archivedFilterLabel("only"), "只看归档");
	});
});
