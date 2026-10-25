import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTranscript } from "../../../src/tui/transcript.ts";
import type { TranscriptLine, TranscriptThinking, TranscriptTool } from "../../../src/tui/transcript.ts";


function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("块级间距", () => {
	function rowsOf(response: readonly TranscriptLine[]): readonly string[] {
		return renderTranscript(40, 12, [{ prompt: "hi", response }], 0)
			.map(plain)
			.map((line) => line.trimEnd());
	}

	it("正文与工具批次之间空一行，连续工具之间保持紧凑", () => {
		const rows = rowsOf([
			"先看看项目结构。",
			{ kind: "tool", name: "Bash", detail: "ls" },
			{ kind: "tool", name: "List", detail: "." },
		]);

		const textRow = rows.findIndex((line) => line.includes("先看看项目结构"));
		const bashRow = rows.findIndex((line) => line.includes("› Bash"));
		const listRow = rows.findIndex((line) => line.includes("› List"));

		assert.equal(bashRow, textRow + 2);
		assert.equal(rows[textRow + 1], "");
		assert.equal(listRow, bashRow + 1);
	});

	it("失败原因紧跟自己的调用行，前后仍是独立块", () => {
		const rows = rowsOf([
			"先执行一下。",
			{ kind: "tool", name: "Bash", detail: "exit 1" },
			{ kind: "tool", name: "Bash", detail: "exit code 1", isError: true, durationMs: 5 },
			"换个方式继续。",
		]);

		const callRow = rows.findIndex((line) => line.includes("› Bash"));
		const failedRow = rows.findIndex((line) => line.includes("× Bash"));
		const textRow = rows.findIndex((line) => line.includes("换个方式继续"));

		// 失败行贴着自己的调用行；它和后文之间仍留一行
		assert.equal(failedRow, callRow + 1);
		assert.equal(rows[callRow - 1], "");
		assert.equal(rows[failedRow + 1], "");
		assert.equal(textRow, failedRow + 2);
	});

	it("失败原因里的回车不会覆盖整行", () => {
		const response: TranscriptLine[] = [
			{ kind: "tool", name: "Bash", detail: "BubbleSort.java:4: 编码错误\r", isError: true, durationMs: 464 },
			...Array.from({ length: 12 }, (_, index) => `line ${index}`),
		];
		const rows = renderTranscript(80, 6, [{ prompt: "hi", response }], 0);
		const row = rows.find((line) => line.includes("× Bash")) ?? "";
		const text = plain(row);

		assert.equal(row.includes("\r"), false);
		assert.ok(text.startsWith("  × Bash  BubbleSort.java:4: 编码错误"));
		assert.ok(text.includes("(0.5s)"));
	});

	it("失败调用行自身显示命令与耗时，展开显示命令和错误详情", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "javac -d out BubbleSort.java",
			isError: true,
			durationMs: 363,
			fullDetail: "javac -d out BubbleSort.java\n\nBubbleSort.java:4: 编码错误",
			detailKind: "text",
			detailExpanded: true,
		};
		const expanded = renderTranscript(80, 12, [{ prompt: "hi", response: [tool] }], 0)
			.map((line) => plain(line))
			.join("\n");

		assert.ok(expanded.includes("× Bash  javac -d out BubbleSort.java (0.4s)"));
		assert.ok(expanded.includes("BubbleSort.java:4: 编码错误"));
		assert.equal(expanded.includes("× Bash  BubbleSort.java:4"), false);

		const collapsedTool: TranscriptTool = { ...tool, detailExpanded: false };
		const collapsed = renderTranscript(80, 12, [{ prompt: "hi", response: [collapsedTool] }], 0)
			.map((line) => plain(line))
			.join("\n");
		assert.ok(collapsed.includes("× Bash  javac -d out BubbleSort.java (0.4s)"));
		assert.equal(collapsed.includes("编码错误"), false);
	});

	it("展开结果里的回车与转义序列不会带进终端", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "ls",
			result: "first\r\n\u001b[31mred\u001b[0m",
			resultExpanded: true,
		};
		const rows = renderTranscript(40, 10, [{ prompt: "hi", response: [tool] }], 0);
		const text = rows.map(plain).join("\n");

		assert.equal(rows.join("").includes("\r"), false);
		assert.equal(text.includes("\u001b"), false);
		assert.ok(text.includes("first"));
		assert.ok(text.includes("red"));
	});

	it("思考块与正文之间空一行，标题与思考正文之间留一行色带", () => {
		const block: TranscriptThinking = {
			kind: "thinkingBlock",
			header: "Thinking…",
			body: ["先读文件", "再决定"],
			partial: "",
			running: true,
			expanded: true,
		};
		const rows = rowsOf([block, "开始吧。"]);

		const headerRow = rows.findIndex((line) => line.includes("Thinking…"));
		const lastBodyRow = rows.findIndex((line) => line.includes("再决定"));
		const textRow = rows.findIndex((line) => line.includes("开始吧"));

		// 标题、上内边距、两行正文、下内边距、块间距、正文
		assert.equal(lastBodyRow, headerRow + 3);
		assert.equal(textRow, lastBodyRow + 3);
		assert.equal(rows[lastBodyRow + 1], "");
		assert.equal(rows[lastBodyRow + 2], "");
	});
});
