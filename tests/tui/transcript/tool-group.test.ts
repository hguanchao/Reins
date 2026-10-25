import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appendToolLine, collapseToolGroups, renderTranscript, toolGroupHeaderAtRow, toolHeaderAtRow } from "../../../src/tui/transcript.ts";
import type { TranscriptLine, TranscriptTool, TranscriptToolGroup, TranscriptTurn } from "../../../src/tui/transcript.ts";


function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("工具组", () => {
	const read = (path: string): TranscriptTool => ({ kind: "tool", name: "Read", detail: path, group: "read" });
	const list = (path: string): TranscriptTool => ({ kind: "tool", name: "List", detail: path, group: "list" });
	const search = (pattern: string): TranscriptTool => ({ kind: "tool", name: "Grep", detail: pattern, group: "search" });
	const command = (cmd: string): TranscriptTool => ({ kind: "tool", name: "Bash", detail: cmd, group: "command" });

	function groupOf(members: readonly TranscriptTool[], expanded: boolean): TranscriptToolGroup {
		return { kind: "toolGroup", members: [...members], expanded };
	}

	function kindAt(lines: readonly TranscriptLine[], index: number): string | undefined {
		const line = lines[index];
		return typeof line === "string" || line === undefined ? undefined : line.kind;
	}

	function groupAt(lines: readonly TranscriptLine[], index: number): TranscriptToolGroup {
		const line = lines[index];
		if (typeof line !== "object" || line === null || line.kind !== "toolGroup") {
			throw new Error("expected a tool group");
		}
		return line;
	}

	it("两个以上连续只读调用折叠成组头", () => {
		const group = groupOf([read("a.ts"), read("b.ts"), list("src")], false);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Read 2 files, Listed 1 dir"));
		assert.equal(text.includes("a.ts"), false);
	});

	it("展开后按成员缩进显示完整工具行", () => {
		const group = groupOf([read("a.ts"), read("b.ts"), list("src")], true);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  ◈ Read 2 files, Listed 1 dir"));
		assert.ok(text.includes("    › Read  a.ts"));
		assert.ok(text.includes("    › Read  b.ts"));
		assert.ok(text.includes("    › List  src"));
	});

	it("组头按 Read、Listed、Searched 汇总并处理单复数", () => {
		const group = groupOf([read("a"), list("src"), search("TODO"), search("FIXME")], false);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("Read 1 file, Listed 1 dir, Searched 2 patterns"));
	});

	it("只有一个成员时仍按普通工具行显示", () => {
		const group = groupOf([read("a.ts")], false);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Read  a.ts"));
		assert.equal(text.includes("Read 1 file"), false);
	});

	it("追加工具时只在连续只读调用之间成组", () => {
		const lines: TranscriptLine[] = [];
		appendToolLine(lines, read("a"), true);
		assert.equal(kindAt(lines, 0), "tool");

		appendToolLine(lines, read("b"), true);
		const group = groupAt(lines, 0);
		assert.equal(group.members.length, 2);
		assert.equal(group.expanded, true);

		appendToolLine(lines, { kind: "tool", name: "Bash", detail: "npm test" }, true);
		assert.equal(kindAt(lines, 1), "tool");

		appendToolLine(lines, read("c"), true);
		appendToolLine(lines, read("d"), true);
		const next = groupAt(lines, 2);
		assert.equal(next.members.length, 2);

		lines.push("text");
		appendToolLine(lines, read("e"), true);
		assert.equal(kindAt(lines, lines.length - 1), "tool");

		collapseToolGroups(lines);
		assert.equal(group.expanded, false);
		assert.equal(next.expanded, false);
	});

	it("组头可以命中，成员行不能", () => {
		const group = groupOf([read("a.ts"), read("b.ts")], false);
		const turn: TranscriptTurn = { prompt: "hi", response: [group] };
		const row =
			renderTranscript(40, 10, [turn], 0)
				.map(plain)
				.findIndex((line) => line.includes("Read 2 files")) + 1;

		assert.equal(toolGroupHeaderAtRow(40, 10, [turn], 0, row), group);
		assert.equal(toolGroupHeaderAtRow(40, 10, [turn], 0, row + 1), undefined);
	});

	it("展开的组成员行可以各自命中并展开详情", () => {
		const first: TranscriptTool = { ...read("a.ts"), fullDetail: "path: src/a.ts" };
		const second: TranscriptTool = { ...read("b.ts"), fullDetail: "path: src/b.ts" };
		const group = groupOf([first, second], true);
		const turn: TranscriptTurn = { prompt: "hi", response: [group] };
		const rows = renderTranscript(60, 12, [turn], 0).map(plain);
		const headerRow = rows.findIndex((line) => line.includes("Read 2 files")) + 1;
		const firstRow = rows.findIndex((line) => line.includes("› Read  a.ts")) + 1;
		const secondRow = rows.findIndex((line) => line.includes("› Read  b.ts")) + 1;

		assert.equal(toolGroupHeaderAtRow(60, 12, [turn], 0, headerRow), group);
		assert.equal(toolHeaderAtRow(60, 12, [turn], 0, firstRow), first);
		assert.equal(toolHeaderAtRow(60, 12, [turn], 0, secondRow), second);
		assert.equal(toolGroupHeaderAtRow(60, 12, [turn], 0, firstRow), undefined);

		first.detailExpanded = true;
		const text = renderTranscript(60, 12, [turn], 0)
			.map(plain)
			.join("\n");
		assert.ok(text.includes("path: src/a.ts"));
	});

	it("运行期命令各自独立成行，不即时进组", () => {
		const lines: TranscriptLine[] = [];
		for (let i = 0; i < 5; i += 1) appendToolLine(lines, command(`cmd${i}`), true);
		// 五条命令行都还是独立的 tool 行：结果回挂与失败行都依赖这一点
		assert.equal(lines.length, 5);
		assert.ok(lines.every((line) => typeof line === "object" && line !== null && line.kind === "tool"));
	});

	it("命令不会被只读工具并进组", () => {
		const lines: TranscriptLine[] = [];
		appendToolLine(lines, read("a"), true);
		appendToolLine(lines, command("npm test"), true);
		assert.equal(kindAt(lines, 0), "tool");
		assert.equal(kindAt(lines, 1), "tool");
	});

	it("回合结束连续够数的命令塌成一个收起的命令组", () => {
		const lines: TranscriptLine[] = [];
		for (let i = 0; i < 5; i += 1) appendToolLine(lines, command(`cmd${i}`), true);
		collapseToolGroups(lines);

		assert.equal(lines.length, 1);
		const group = groupAt(lines, 0);
		assert.equal(group.members.length, 5);
		assert.equal(group.expanded, false);
	});

	it("不足门槛的连续命令保持逐行", () => {
		const lines: TranscriptLine[] = [];
		for (let i = 0; i < 4; i += 1) appendToolLine(lines, command(`cmd${i}`), true);
		collapseToolGroups(lines);
		assert.equal(lines.length, 4);
		assert.ok(lines.every((line) => typeof line === "object" && line !== null && line.kind === "tool"));
	});

	it("失败的命令不进组，留在顶层可见", () => {
		const lines: TranscriptLine[] = [];
		for (let i = 0; i < 5; i += 1) appendToolLine(lines, command(`cmd${i}`), true);
		// 把第三条标成失败：塌缩时它要留在组外
		const third = lines[2];
		if (typeof third === "object" && third !== null && third.kind === "tool") third.isError = true;
		collapseToolGroups(lines);

		// 失败行把命令串切成两段：前两条与后两条都不足门槛，全部保持逐行
		assert.equal(lines.length, 5);
		const failed = lines[2];
		assert.ok(typeof failed === "object" && failed !== null && failed.kind === "tool" && failed.isError === true);
	});

	it("命令组头汇总为 Ran N commands", () => {
		const group = groupOf(
			[command("npm test"), command("git status"), command("ls"), command("pwd"), command("whoami")],
			false,
		);
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");
		assert.ok(text.includes("Ran 5 commands"));
		assert.equal(text.includes("npm test"), false);
	});

	it("命令组展开后逐条显示成员", () => {
		const group = groupOf(
			[command("npm test"), command("git status"), command("ls"), command("pwd"), command("whoami")],
			true,
		);
		const text = renderTranscript(60, 12, [{ prompt: "hi", response: [group] }], 0)
			.map(plain)
			.join("\n");
		assert.ok(text.includes("◈ Ran 5 commands"));
		assert.ok(text.includes("› Bash  npm test"));
		assert.ok(text.includes("› Bash  git status"));
	});
});
