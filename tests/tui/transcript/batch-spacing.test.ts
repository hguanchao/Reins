import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTranscript } from "../../../src/tui/transcript.ts";
import type { TranscriptThinking, TranscriptLine, TranscriptTool } from "../../../src/tui/transcript.ts";

function plain(line: string): string {
	return line
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.trimEnd();
}

function think(header: string): TranscriptThinking {
	return { kind: "thinkingBlock", header, body: ["…"], partial: "", running: false, expanded: false };
}

function tool(detail: string): TranscriptTool {
	return { kind: "tool", name: "List", detail };
}

describe("一轮调用批次的间距", () => {
	function rowsOf(response: readonly TranscriptLine[]): readonly string[] {
		return renderTranscript(40, 20, [{ prompt: "hi", response }], 0).map(plain);
	}

	it("思考与工具的交替保持紧凑，批次结束与回复之间留空行", () => {
		const rows = rowsOf([
			think("Thought for 1.4s"),
			tool("."),
			think("Thought for 1.1s"),
			tool("1 file"),
			"这是回复。",
		]);

		const thought1 = rows.findIndex((line) => line.includes("Thought for 1.4s"));
		const list = rows.findIndex((line) => line.includes("List") && line.includes("."));
		const thought2 = rows.findIndex((line) => line.includes("Thought for 1.1s"));
		const read = rows.findIndex((line) => line.includes("1 file"));
		const text = rows.findIndex((line) => line.includes("这是回复"));

		// 批次内相邻行紧密相连
		assert.notEqual(thought1, -1);
		assert.equal(list, thought1 + 1);
		assert.equal(thought2, list + 1);
		assert.equal(read, thought2 + 1);
		// 批次结束与回复之间留一行
		assert.equal(rows[read + 1], "");
		assert.equal(text, read + 2);
	});

	it("连续两个思考区块仍然各自独立成块", () => {
		const rows = rowsOf([think("Thought for 1s"), think("Thought for 2s")]);
		const first = rows.findIndex((line) => line.includes("Thought for 1s"));
		const second = rows.findIndex((line) => line.includes("Thought for 2s"));
		assert.equal(rows[first + 1], "");
		assert.equal(second, first + 2);
	});

	it("工具批次结束（回合以工具收尾）与下一条提示之间留空行", () => {
		const rows = renderTranscript(
			40,
			20,
			[
				{ prompt: "第一问", response: [think("Thought for 1s"), tool(".")] },
				{ prompt: "第二问", response: [] },
			],
			0,
		).map(plain);
		const toolRow = rows.findIndex((line) => line.includes("List") && line.includes("."));
		const second = rows.findIndex((line) => line.includes("第二问"));
		// 工具行之后有空行，提示块不直接贴住批次
		assert.equal(rows[toolRow + 1], "");
		assert.ok(second > toolRow + 1);
	});
});
