import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "#web/protocol.ts";
import {
	BUCKET_LABELS,
	bucketOf,
	bucketRows,
	buildSessionRows,
	buildSessionGroups,
	toggleAllWorkspaceGroups,
} from "#web/shell/session-tree.ts";

const sessions: readonly SessionSummary[] = [
	{ id: "a", title: "修复登录", updatedAt: "2026-11-03T10:00:00.000Z" },
	{ id: "b", title: undefined, updatedAt: "2026-11-03T09:00:00.000Z" },
	{ id: "c", title: "写文档", updatedAt: "2026-11-03T08:00:00.000Z" },
];

/** 归档会话不再进入侧栏，列表输入没有 archived 入口。 */
function rows(overrides: Partial<Parameters<typeof buildSessionRows>[0]> = {}) {
	return buildSessionRows({
		sessions,
		pinned: new Set(),
		query: "",
		currentId: "",
		currentIsDraft: false,
		...overrides,
	});
}

describe("会话列表投影", () => {
	it("保持服务端给的更新时间顺序，置顶行提到最前", () => {
		const list = rows({ pinned: new Set(["c"]) });
		assert.deepEqual(
			list.map((row) => row.id),
			["c", "a", "b"],
		);
		assert.equal(list[0]?.pinned, true);
		assert.equal(list[1]?.title, "修复登录");
	});

	it("没有标题的会话显示为新任务", () => {
		assert.equal(rows()[1]?.title, "新任务");
	});

	it("搜索忽略大小写，只匹配标题", () => {
		const list = rows({ query: " 修复 " });
		assert.deepEqual(
			list.map((row) => row.id),
			["a"],
		);
	});
});

describe("当前会话补行", () => {
	it("草稿会话不补行：没发送消息前不该出现在工作区列表里", () => {
		const list = rows({ currentId: "draft", currentIsDraft: true });
		assert.deepEqual(
			list.map((row) => row.id),
			["a", "b", "c"],
		);
	});

	it("非草稿又不在清单里的当前会话补一行，排在最前", () => {
		const list = rows({ currentId: "outside" });
		assert.deepEqual(
			list.map((row) => row.id),
			["outside", "a", "b", "c"],
		);
		assert.equal(list[0]?.title, "新任务");
	});

	it("当前会话已在清单里时不重复补行", () => {
		const list = rows({ currentId: "a" });
		assert.deepEqual(
			list.map((row) => row.id),
			["a", "b", "c"],
		);
	});

	it("搜索词对不上时不补行", () => {
		const list = rows({ query: "修复", currentId: "outside" });
		assert.deepEqual(
			list.map((row) => row.id),
			["a"],
		);
	});
});

describe("时间分档", () => {
	// 以本地时间 2026-11-03 12:00 为基准
	const now = new Date(2026, 10, 3, 12, 0, 0).getTime();

	it("当天归今天、前一天归昨天、更早归更早", () => {
		assert.equal(bucketOf(new Date(2026, 10, 3, 9, 0, 0).toISOString(), now), "today");
		assert.equal(bucketOf(new Date(2026, 10, 2, 9, 0, 0).toISOString(), now), "yesterday");
		assert.equal(bucketOf(new Date(2026, 9, 20, 9, 0, 0).toISOString(), now), "earlier");
	});

	it("时间戳损坏时不抛错，归入更早", () => {
		assert.equal(bucketOf("不是时间", now), "earlier");
	});

	it("小节按 进行中 → 今天 → 昨天 → 更早 排列，空小节不出现", () => {
		const groups = bucketRows(
			[
				{ id: "x", title: "正在跑", updatedAt: new Date(2026, 10, 3, 11, 0, 0).toISOString(), pinned: false, cwd: "", workspacePath: null },
				{ id: "y", title: "昨天的", updatedAt: new Date(2026, 10, 2, 9, 0, 0).toISOString(), pinned: false, cwd: "", workspacePath: null },
			],
			{ currentId: "x", running: true, now },
		);
		assert.deepEqual(
			groups.map((group) => group.bucket),
			["active", "yesterday"],
		);
		assert.equal(BUCKET_LABELS.active, "进行中");
	});

	it("当前会话没在跑时不单列进行中", () => {
		const groups = bucketRows(
			[
				{ id: "x", title: "刚发的", updatedAt: new Date(2026, 10, 3, 11, 0, 0).toISOString(), pinned: false, cwd: "", workspacePath: null },
			],
			{ currentId: "x", running: false, now },
		);
		assert.deepEqual(
			groups.map((group) => group.bucket),
			["today"],
		);
	});
});

describe("归属分层", () => {
	const workspaces = [
		{ path: "/项目/a", name: "项目 A" },
		{ path: "/项目/b", name: "项目 B" },
	];

	it("绑定项目的会话只出现在所属项目下，未绑定的留在任务区", () => {
		const groups = buildSessionGroups({
			sessions: [
				{ id: "1", title: "任务区", updatedAt: "2026-11-03T10:00:00.000Z" },
				{ id: "2", title: "项目 A 的", updatedAt: "2026-11-03T09:00:00.000Z", workspacePath: "/项目/a" },
				{ id: "3", title: "项目 B 的", updatedAt: "2026-11-03T08:00:00.000Z", workspacePath: "/项目/b" },
			],
			workspaces,
			pinned: new Set(),
			query: "",
			currentId: "",
			currentIsDraft: false,
		});
		assert.deepEqual(
			groups.unassigned.map((row) => row.id),
			["1"],
		);
		assert.deepEqual(
			groups.workspaces.map((group) => group.rows.map((row) => row.id)),
			[["2"], ["3"]],
		);
	});
});

describe("工作区分组折叠", () => {
	const groups = [
		{ workspace: { path: "/项目/a", name: "项目 A" }, rows: [] },
		{ workspace: { path: "/项目/b", name: "项目 B" }, rows: [] },
	] as const;

	it("全部展开时一次收起所有项目", () => {
		assert.deepEqual(toggleAllWorkspaceGroups(groups, {}), {
			"/项目/a": false,
			"/项目/b": false,
		});
	});

	it("存在已收起项目时一次展开所有项目", () => {
		assert.deepEqual(toggleAllWorkspaceGroups(groups, { "/项目/a": false, "/项目/b": true }), {
			"/项目/a": true,
			"/项目/b": true,
		});
	});
});
