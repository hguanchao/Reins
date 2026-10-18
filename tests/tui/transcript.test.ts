import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTranscript, transcriptMetrics } from "../../src/tui/transcript.ts";

const PROMPT_BG = "\x1b[48;2;36;36;36m";
const PROMPT_PREFIX = "\x1b[38;2;200;200;200m";
const PROMPT_TEXT = "\x1b[38;2;225;225;225m";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("对话流", () => {
	it("用户提示使用 #242424 背景和指定前缀/正文颜色，上下留一行背景", () => {
		const lines = renderTranscript(40, 8, [{ prompt: "hello", response: [] }], 0);

		assert.equal(lines.length, 8);
		assert.ok(plain(lines[1] ?? "").startsWith("› hello"));
		assert.equal(plain(lines[1] ?? "").length, 40);
		assert.ok((lines[0] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.ok((lines[2] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(PROMPT_PREFIX));
		assert.ok((lines[1] ?? "").includes(PROMPT_TEXT));
		assert.equal((lines[3] ?? "").includes(PROMPT_BG), false);
	});

	it("提示正文最多三行，超出用省略号", () => {
		const lines = renderTranscript(20, 10, [{ prompt: "一".repeat(50), response: [] }], 0);

		assert.ok((lines[0] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.ok((lines[2] ?? "").includes(PROMPT_BG));
		assert.ok((lines[3] ?? "").includes(PROMPT_BG));
		assert.ok((lines[4] ?? "").includes(PROMPT_BG));
		assert.equal((lines[5] ?? "").includes(PROMPT_BG), false);
		assert.ok(plain(lines[3] ?? "").includes("…"));
	});

	it("回复滚出视口后提示吸顶，下面固定一行 gap", () => {
		const response = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
		const lines = renderTranscript(40, 6, [{ prompt: "hello", response }], 6);

		assert.ok(plain(lines[1] ?? "").startsWith("› hello"));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.equal(plain(lines[3] ?? "").includes("›"), false);
		assert.equal((lines[3] ?? "").includes(PROMPT_BG), false);
		assert.ok(plain(lines[4] ?? "").startsWith("  g"));
		assert.ok(plain(lines[5] ?? "").startsWith("  h"));
		assert.ok(plain(lines[0] ?? "").endsWith("│"));
		assert.ok(plain(lines[3] ?? "").endsWith("█"));
	});

	it("给出最后一条提示的起始行，供发送后翻页", () => {
		const metrics = transcriptMetrics(40, 6, [
			{ prompt: "a", response: ["x"] },
			{ prompt: "b", response: [] },
		]);

		assert.equal(metrics.totalLines, 9);
		assert.equal(metrics.scrollLines, 11);
		assert.equal(metrics.lastPromptStart, 5);
	});
});
