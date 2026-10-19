import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTranscript, transcriptMetrics } from "../../src/tui/transcript.ts";

const PROMPT_BG = "\x1b[48;2;22;25;29m";
const MESSAGE_TEXT = "\x1b[38;2;230;233;237m";
const NOTICE_TEXT = "\x1b[38;2;224;175;104m";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("对话流", () => {
	it("用户提示使用 #16191d 背景和指定前缀/正文颜色，上下留一行背景", () => {
		const lines = renderTranscript(40, 8, [{ prompt: "hello", response: [] }], 0);

		assert.equal(lines.length, 8);
		assert.ok(plain(lines[1] ?? "").startsWith(" › hello"));
		assert.equal(plain(lines[1] ?? "").length, 40);
		assert.ok((lines[0] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.ok((lines[2] ?? "").includes(PROMPT_BG));
		assert.ok((lines[1] ?? "").includes(MESSAGE_TEXT));
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

		assert.ok(plain(lines[1] ?? "").startsWith(" › hello"));
		assert.ok((lines[1] ?? "").includes(PROMPT_BG));
		assert.equal(plain(lines[3] ?? "").includes("›"), false);
		assert.equal((lines[3] ?? "").includes(PROMPT_BG), false);
		assert.ok(plain(lines[4] ?? "").startsWith("  g"));
		assert.ok(plain(lines[5] ?? "").startsWith("  h"));
		assert.ok((lines[4] ?? "").includes(MESSAGE_TEXT));
		assert.equal(plain(lines[0] ?? "").endsWith("│"), false);
		assert.ok(plain(lines[0] ?? "").endsWith(" "));
		assert.ok(plain(lines[3] ?? "").endsWith("█"));
	});

	it("吸顶时不会把下一条提示切掉顶部留白", () => {
		const lines = renderTranscript(
			40,
			8,
			[
				{ prompt: "one", response: ["x"] },
				{ prompt: "two", response: ["a", "b", "c"] },
			],
			4,
		).map(plain);

		assert.ok(lines[1]?.startsWith(" › one"));
		assert.equal(lines[4]?.includes("›"), false);
		assert.ok(lines[5]?.startsWith(" › two"));
		assert.equal(lines[6]?.includes("›"), false);
	});

	it("上一条回复和下一条提示之间留一行间距", () => {
		const lines = renderTranscript(
			40,
			20,
			[
				{ prompt: "one", response: ["x"] },
				{ prompt: "two", response: [] },
			],
			0,
		);

		assert.ok(plain(lines[4] ?? "").includes("x"));
		assert.equal((lines[5] ?? "").includes(PROMPT_BG), false);
		assert.ok((lines[6] ?? "").includes(PROMPT_BG));
		assert.ok(plain(lines[7] ?? "").startsWith(" › two"));
	});

	it("给出最后一条提示的起始行，供发送后翻页", () => {
		const metrics = transcriptMetrics(40, 6, [
			{ prompt: "a", response: ["x"] },
			{ prompt: "b", response: [] },
		]);

		assert.equal(metrics.totalLines, 10);
		assert.equal(metrics.scrollLines, 12);
		assert.equal(metrics.lastPromptStart, 6);
	});

	it("启动警告作为对话流顶部的系统消息显示", () => {
		const lines = renderTranscript(40, 6, [], 0, "Config error: No provider openai");
		const text = lines.map(plain).join("\n");

		assert.ok(text.includes("! Config error:"));
		assert.ok(text.includes("No provider"));
		assert.ok(plain(lines[0] ?? "").startsWith("  ! Config error:"));
		assert.ok((lines[0] ?? "").includes(NOTICE_TEXT));
		assert.equal((lines[0] ?? "").includes(PROMPT_BG), false);
	});

	it("警告参与行数与滚动计算", () => {
		const metrics = transcriptMetrics(40, 6, [], `Config error: ${"x".repeat(200)}`);

		assert.ok(metrics.totalLines > 6);
	});

	it("没有轮次也没有警告时保持空白", () => {
		assert.deepEqual(renderTranscript(40, 3, [], 0), ["", "", ""]);
	});

	it("内容没有超出视口时不显示滚动条", () => {
		const lines = renderTranscript(40, 10, [], 0, "Config error: No provider openai");

		assert.ok(lines.every((line) => !plain(line).includes("█")));
	});
});
