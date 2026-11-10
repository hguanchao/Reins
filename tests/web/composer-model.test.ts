import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	APPROVAL_LABELS,
	EFFORT_LABELS,
	MIN_LINES,
	fileMentionPath,
	groupMentions,
	hitRate,
	mentionItems,
	serverStatusLabel,
	workspaceChipName,
	type MentionState,
} from "#web/chat/composer/model.ts";
import type { SkillInfo, UsageSummary } from "#web/protocol.ts";

const skills: readonly SkillInfo[] = [
	{ name: "frontend-design", description: "界面设计", path: "/a", scope: "user", editable: true },
	{ name: "grilling", description: "方案质询", path: "/b", scope: "user", editable: true },
	{ name: "git-workflow", description: "提交流程", path: "/c", scope: "project", editable: false },
];

function state(kind: MentionState["kind"], query = ""): MentionState {
	return { kind, query, start: 0, files: [], index: 0 };
}

function usage(overrides: Partial<UsageSummary> = {}): UsageSummary {
	return {
		requests: 1,
		input: 100,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		total: 120,
		cost: undefined,
		...overrides,
	};
}

describe("输入补全候选", () => {
	it("文件补全只列文件，不掺技能", () => {
		const current: MentionState = { ...state("file"), files: ["src/a.ts", "src/b.ts"] };
		assert.deepEqual(mentionItems(current, skills), [
			{ token: "src/a.ts", description: "" },
			{ token: "src/b.ts", description: "" },
		]);
	});

	it("技能补全按名字过滤且最多八条", () => {
		assert.deepEqual(mentionItems(state("skill", "GIT"), skills), [
			{ token: "git-workflow", description: "提交流程" },
		]);
		assert.equal(mentionItems(state("skill", ""), skills).length, 3);
	});

	it("命令补全把命令放前、技能放后", () => {
		const items = mentionItems(state("command"), skills);
		assert.equal(items[0]?.token, "/compact");
		assert.ok(items.some((item) => item.token === "frontend-design"));
		assert.equal(items.filter((item) => item.token.startsWith("/")).length, 3);
	});

	it("没有触发词时不产生候选", () => {
		assert.deepEqual(mentionItems(undefined, skills), []);
		assert.deepEqual(groupMentions(undefined, []), []);
	});
});

describe("补全分组", () => {
	it("只有斜杠触发时分命令与技能两组", () => {
		const items = mentionItems(state("command"), skills);
		const groups = groupMentions(state("command"), items);
		assert.deepEqual(
			groups.map((group) => group.label),
			["命令", "技能"],
		);
		assert.ok(groups[0]?.items.every((item) => item.token.startsWith("/")));
		assert.ok(groups[1]?.items.every((item) => !item.token.startsWith("/")));
	});

	it("文件与技能各自单组，空组不出现", () => {
		assert.deepEqual(groupMentions(state("file"), [{ token: "a.ts", description: "" }]), [
			{ label: "文件", items: [{ token: "a.ts", description: "" }] },
		]);
		assert.deepEqual(groupMentions(state("skill"), []), [{ label: "技能", items: [] }]);
		assert.deepEqual(groupMentions(state("command"), []), []);
	});
});

describe("状态读数", () => {
	it("缓存命中率只统计输入侧，输出不参与", () => {
		assert.equal(hitRate(usage({ input: 100, cacheRead: 50, cacheWrite: 50 })), 25);
		assert.equal(
			hitRate(usage({ input: 0, cacheRead: 0, cacheWrite: 0, output: 999 })),
			undefined,
		);
	});

	it("连接器状态逐档映射，未知值落在未连接", () => {
		assert.equal(serverStatusLabel("connected"), "已连接");
		assert.equal(serverStatusLabel("connecting"), "连接中");
		assert.equal(serverStatusLabel("unreachable"), "连接失败");
		assert.equal(serverStatusLabel("disabled"), "已禁用");
		assert.equal(serverStatusLabel("something-else"), "未连接");
	});
});

describe("共享常量", () => {
	it("输入行数与档名保持单一来源", () => {
		assert.equal(MIN_LINES, 2);
		assert.equal(APPROVAL_LABELS.ask, "逐次询问");
		assert.equal(EFFORT_LABELS.max, "最大");
	});
});

describe("工作区芯片显示名", () => {
	const rows = [
		{ path: "/work/reins", name: "Reins1" },
		{ path: "/work/other", name: "Other" },
	] as const;

	it("已绑定的会话优先用登记表中的显示名，而不是目录名", () => {
		assert.equal(workspaceChipName(rows, "/work/reins", "reins"), "Reins1");
	});

	it("未绑定时留空，由界面显示「选择工作区」", () => {
		assert.equal(workspaceChipName(rows, null, "reins"), "");
		assert.equal(workspaceChipName(rows, undefined, "reins"), "");
		assert.equal(workspaceChipName(rows, "", "reins"), "");
	});

	it("清单还没加载完时退回目录名，不闪空壳", () => {
		assert.equal(workspaceChipName([], "/work/reins", "reins"), "reins");
	});
});

describe("文件选择器路径转 @ 引用", () => {
	it("工作区内的文件转成相对路径", () => {
		assert.equal(fileMentionPath("/work/reins/src/a.ts", "/work/reins"), "src/a.ts");
	});

	it("Windows 反斜杠与大小写差异都归一化", () => {
		assert.equal(fileMentionPath("C:\\Work\\Reins\\src\\a.ts", "C:/work/reins"), "src/a.ts");
	});

	it("工作区外的文件保留绝对路径", () => {
		assert.equal(fileMentionPath("C:/Users/Chao/Desktop/a.ts", "C:/work/reins"), "C:/Users/Chao/Desktop/a.ts");
	});

	it("没有项目根时直接用绝对路径", () => {
		assert.equal(fileMentionPath("C:/Users/Chao/Desktop/a.ts", ""), "C:/Users/Chao/Desktop/a.ts");
	});

	it("同前缀但不是同一目录不会被误判成工作区内", () => {
		assert.equal(fileMentionPath("/work/reins-extra/a.ts", "/work/reins"), "/work/reins-extra/a.ts");
	});

	it("项目根末尾的斜杠不影响判定", () => {
		assert.equal(fileMentionPath("/work/reins/a.ts", "/work/reins/"), "a.ts");
	});
});
