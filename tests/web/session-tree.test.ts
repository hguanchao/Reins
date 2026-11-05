import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "#web/protocol.ts";
import { buildSessionRows, sidebarSectionVisibility, toggleAllWorkspaceGroups } from "#web/shell/session-tree.ts";

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

describe("分组可见性", () => {
	it("各段按自己的折叠状态", () => {
		assert.deepEqual(sidebarSectionVisibility(false, true, false), { tasks: true, spaces: false });
		assert.deepEqual(sidebarSectionVisibility(false, false, true), { tasks: false, spaces: true });
	});

	it("搜索时两段强制展开，命中的会话不会被藏进折叠里", () => {
		assert.deepEqual(sidebarSectionVisibility(true, false, false), { tasks: true, spaces: true });
	});
});

describe("空间项目分组折叠", () => {
	const groups = [
		{ workspace: { path: "/项目/a", name: "项目 A" }, rows: [] },
		{ workspace: { path: "/项目/b", name: "项目 B" }, rows: [] },
	] as const;

	it("全部展开时只收起空间下的所有项目", () => {
		assert.deepEqual(toggleAllWorkspaceGroups(groups, {}), {
			"/项目/a": false,
			"/项目/b": false,
		});
	});

	it("存在已收起项目时一次展开所有项目", () => {
		assert.deepEqual(
			toggleAllWorkspaceGroups(groups, { "/项目/a": false, "/项目/b": true }),
			{
				"/项目/a": true,
				"/项目/b": true,
			},
		);
	});
});
