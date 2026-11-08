import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupable, groupTurns, splitToolRun, toolAction, turnCount } from "#web/transcript/blocks.ts";
import { diffStats, parseDiff } from "#web/transcript/diff.ts";
import type { Line, ToolLine } from "#web/transcript/lines.ts";

/**
 * 会话流的分块与 diff 解析：都是纯函数，渲染层只消费它们的产物。
 */

function tool(callId: string, name: string): ToolLine {
	return {
		kind: "tool",
		callId,
		name,
		args: undefined,
		running: false,
		isError: false,
		durationMs: 10,
		summary: "ok",
		detail: "",
		content: undefined,
		details: undefined,
	};
}

describe("工具动作分流", () => {
	it("读取、搜索、列目录、写入、运行各自归类", () => {
		assert.equal(toolAction("read"), "read");
		assert.equal(toolAction("grep"), "search");
		assert.equal(toolAction("find"), "search");
		assert.equal(toolAction("ls"), "list");
		assert.equal(toolAction("edit"), "write");
		assert.equal(toolAction("write"), "write");
		assert.equal(toolAction("patch"), "write");
		assert.equal(toolAction("bash"), "run");
		assert.equal(toolAction("pwsh"), "run");
		assert.equal(toolAction("mcp__docs__search"), "mcp");
	});

	it("只有读取类参与并组，写入与运行各自成行", () => {
		assert.equal(groupable("read"), true);
		assert.equal(groupable("grep"), true);
		assert.equal(groupable("ls"), true);
		assert.equal(groupable("edit"), false);
		assert.equal(groupable("bash"), false);
	});
});

describe("工具行切块", () => {
	it("连续读取并成一组，写入独立成行", () => {
		const blocks = splitToolRun([tool("a", "read"), tool("b", "read"), tool("c", "edit")]);
		assert.equal(blocks.length, 2);
		const [group, single] = blocks;
		assert.equal(group?.kind, "group");
		if (group?.kind === "group") {
			assert.equal(group.reads, 2);
			assert.equal(group.searches, 0);
		}
		assert.equal(single?.kind, "single");
	});

	it("单个读取不并组，仍是一行摘要", () => {
		const blocks = splitToolRun([tool("a", "read")]);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]?.kind, "single");
	});

	it("混合读取与搜索时同组计数各自累加", () => {
		const blocks = splitToolRun([tool("a", "read"), tool("b", "grep"), tool("c", "ls")]);
		const group = blocks[0];
		assert.equal(group?.kind, "group");
		if (group?.kind === "group") {
			assert.equal(group.reads, 1);
			assert.equal(group.searches, 1);
			assert.equal(group.lists, 1);
		}
	});

	it("空输入不产生块", () => {
		assert.deepEqual(splitToolRun([]), []);
	});
});

describe("回合切分", () => {
	const user = (text: string): Line => ({ kind: "user", text });

	it("每次提问开一轮，轮内保留后续行", () => {
		const turns = groupTurns([
			user("一"),
			{ kind: "assistant", text: "答一", open: false },
			user("二"),
			{ kind: "assistant", text: "答二", open: false },
		]);
		assert.equal(turns.length, 2);
		assert.equal(turns[0]?.ask?.text, "一");
		assert.equal(turns[0]?.lines.length, 1);
		assert.equal(turns[1]?.ask?.text, "二");
	});

	it("提问之前的零散行归入第一轮，不丢内容", () => {
		const turns = groupTurns([{ kind: "assistant", text: "开场", open: false }, user("问")]);
		assert.equal(turns.length, 2);
		assert.equal(turns[0]?.ask, undefined);
		assert.equal(turns[0]?.lines.length, 1);
		assert.equal(turns[1]?.ask?.text, "问");
	});

	it("没有提问的整段流也算一轮", () => {
		const turns = groupTurns([{ kind: "notice", text: "提示", tone: "info" }]);
		assert.equal(turns.length, 1);
		assert.equal(turns[0]?.ask, undefined);
	});

	it("空流不产生回合", () => {
		assert.deepEqual(groupTurns([]), []);
	});

	it("轮数等于提问数", () => {
		assert.equal(turnCount([user("一"), { kind: "assistant", text: "a", open: false }, user("二")]), 2);
	});
});

describe("diff 解析", () => {
	it("增删行按符号归类，行号连续不跳号", () => {
		const sections = parseDiff(
			["@@ -17,4 +17,5 @@", " export function read() {", "-  const a = 1;", "+  const a = 2;", "+  return a;", " }"].join("\n"),
		);
		assert.equal(sections.length, 1);
		const rows = sections[0]?.rows ?? [];
		assert.deepEqual(
			rows.map((row) => [row.kind, row.no]),
			[
				["ctx", 17],
				["del", 18],
				["add", 18],
				["add", 19],
				["ctx", 20],
			],
		);
		assert.equal(sections[0]?.added, 2);
		assert.equal(sections[0]?.removed, 1);
	});

	it("多文件 diff 按 ### 标题切开", () => {
		const sections = parseDiff(["### a.ts", "+a", "### b.ts", "+b", "+c"].join("\n"));
		assert.deepEqual(
			sections.map((section) => [section.path, section.added]),
			[
				["a.ts", 1],
				["b.ts", 2],
			],
		);
	});

	it("超出上限的行计入省略数，不混进行内", () => {
		const sections = parseDiff(["+1", "+2", "+3", "+4"].join("\n"), 2);
		assert.equal(sections[0]?.rows.length, 2);
		assert.equal(sections[0]?.hidden, 2);
	});

	it("制表符缩进统一换成空格", () => {
		const rows = parseDiff("+\tindent").at(0)?.rows ?? [];
		assert.equal(rows[0]?.text, "    indent");
	});

	it("文件头与 hunk 头不计入增删", () => {
		const text = ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "+line"].join("\n");
		assert.deepEqual(diffStats(text), { added: 1, removed: 0 });
	});

	it("没有 diff 时统计为零", () => {
		assert.deepEqual(diffStats(undefined), { added: 0, removed: 0 });
	});
});
