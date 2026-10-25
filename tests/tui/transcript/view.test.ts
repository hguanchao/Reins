import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEME } from "../../../src/tui/render/theme.ts";
import { renderTranscript, transcriptMetrics } from "../../../src/tui/transcript.ts";
import type { TranscriptThinking, TranscriptTurn } from "../../../src/tui/transcript.ts";

const PROMPT_BG = "\x1b[48;2;22;25;29m";
const MESSAGE_TEXT = "\x1b[38;2;230;233;237m";
const NOTICE_TEXT = "\x1b[38;2;224;175;104m";

function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("对话流", () => {
	it("Markdown 文本块按排版渲染，普通字符串仍按纯文本", () => {
		const rows = renderTranscript(
			40,
			12,
			[
				{
					prompt: "hi",
					response: [
						{ kind: "markdown", text: "## 标题\n\n**粗体**文字" },
						"普通字符串",
					],
				},
			],
			0,
		).map((line) => plain(line).slice(0, -2));

		assert.ok(rows.some((row) => row.trim() === "标题"));
		assert.ok(rows.some((row) => row.includes("粗体文字")));
		assert.ok(rows.some((row) => row.includes("普通字符串")));
		assert.equal(rows.join("\n").includes("##"), false);
		assert.equal(rows.join("\n").includes("**"), false);
	});

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

	it("下一条提示逼近时吸顶块从顶部收起，不截断下一个提示块", () => {
		const turns: TranscriptTurn[] = [
			{ prompt: "one", response: ["x"] },
			{ prompt: "two", response: ["a", "b", "c"] },
		];
		// 行：one 0-2，gap 3，x 4，轮间空行 5，two 6-8，gap 9，a 10…
		const render = (top: number): readonly string[] => renderTranscript(40, 8, turns, top);
		const text = (line: string | undefined): string => plain(line ?? "").slice(0, -2);

		const at3 = render(3);
		const at4 = render(4);
		const at5 = render(5);
		assert.notEqual(at3.map(text).join("\n"), at4.map(text).join("\n"));
		assert.notEqual(at4.map(text).join("\n"), at5.map(text).join("\n"));

		// top=3：吸顶块只剩正文与下留白，two 的上留白、正文、下留白完整
		assert.ok(text(at3[0]).startsWith(" › one"));
		assert.ok((at3[1] ?? "").includes(PROMPT_BG));
		assert.equal(text(at3[2]).trim(), "");
		assert.ok((at3[3] ?? "").includes(PROMPT_BG));
		assert.ok(text(at3[4]).startsWith(" › two"));
		assert.ok((at3[5] ?? "").includes(PROMPT_BG));

		// 提示块完全被顶出去后不再吸顶，正常内容从头开始
		assert.equal(at5.map(text).join("\n").includes(" › one"), false);
		assert.ok(text(at5[2]).startsWith(" › two"));
		assert.ok(render(6).map(text).join("\n").includes("c"));
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

	it("内容只超出少量行时，滚动仍然逐行移动内容", () => {
		const turn: TranscriptTurn = {
			prompt: "hello",
			response: ["r1", "r2", "r3", "r4", "r5", "r6"],
		};
		const at1 = renderTranscript(40, 8, [turn], 1)
			.map((line) => plain(line).slice(0, -2))
			.join("\n");
		const at2 = renderTranscript(40, 8, [turn], 2)
			.map((line) => plain(line).slice(0, -2))
			.join("\n");

		assert.notEqual(at1, at2);
		// 提示吸顶后，第一行内容被盖住，视口里从第二行开始
		assert.equal(at1.includes("r1"), false);
		assert.ok(at1.includes("r2"));
		assert.ok(at2.includes("r3"));
	});

	it("内容未超出视口时不显示滚动条，也不留可滚的空白", () => {
		const lines = renderTranscript(
			40,
			12,
			[
				{ prompt: "one", response: ["x"] },
				{ prompt: "two", response: [] },
			],
			// 请求滚到第 6 行：内容不足一屏时没有可滚的余地，应该停在顶部
			6,
		);

		assert.ok(lines.every((line) => !plain(line).includes("█")));
		// 停在顶部：第一条提示仍在第一行，没有被翻页留白顶上去
		assert.ok(plain(lines[1] ?? "").startsWith(" › one"));
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
		const lines = renderTranscript(40, 6, [], 0, "Warning: No provider openai");
		const text = lines.map(plain).join("\n");

		assert.ok(text.includes("! Warning:"));
		assert.ok(text.includes("No provider"));
		assert.ok(plain(lines[0] ?? "").startsWith("  ! Warning:"));
		assert.ok((lines[0] ?? "").includes(NOTICE_TEXT));
		assert.equal((lines[0] ?? "").includes(PROMPT_BG), false);
	});

	it("警告参与行数与滚动计算", () => {
		const metrics = transcriptMetrics(40, 6, [], `Warning: ${"x".repeat(200)}`);

		assert.ok(metrics.totalLines > 6);
	});

	it("没有轮次也没有警告时保持空白", () => {
		assert.deepEqual(renderTranscript(40, 3, [], 0), ["", "", ""]);
	});

	it("内容没有超出视口时不显示滚动条", () => {
		const lines = renderTranscript(40, 10, [], 0, "Warning: No provider openai");

		assert.ok(lines.every((line) => !plain(line).includes("█")));
	});
	it("思考标题用弱一档的颜色，跟正文区分", () => {
		const block: TranscriptThinking = {
			kind: "thinkingBlock",
			header: "Thought for 1.2s",
			body: ["reasoning"],
			partial: "",
			running: false,
			expanded: false,
		};
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: ["answer", block],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const notice = lines.find((line) => plain(line).includes("Thought for"));
		const body = lines.find((line) => plain(line).includes("answer"));
		assert.ok(notice?.includes(THEME.textSubtle));
		assert.equal(notice?.includes(THEME.textPrimary), false);
		assert.ok(body?.includes(THEME.textPrimary));
	});

	it("警告备注用 ! Warning: 和警告色", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "warning", text: "fallback model used" }],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const warning = lines.find((line) => plain(line).includes("! Warning: fallback model used"));
		assert.ok(warning);
		assert.ok(plain(warning).startsWith("  ! Warning:"));
		assert.ok(warning.includes(THEME.warning));
		assert.equal(warning.includes(THEME.error), false);
	});

	it("错误消息用 × 开头和错误色，出事时一眼能看见", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: ["answer", { text: "Error: boom", kind: "error" }],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const failed = lines.find((line) => plain(line).includes("× Error: boom"));
		const body = lines.find((line) => plain(line).includes("answer"));
		assert.ok(failed);
		assert.ok(plain(failed).startsWith("  × Error: boom"));
		assert.ok(failed.includes(THEME.error));
		assert.equal(failed.includes(THEME.textPrimary), false);
		assert.equal(body?.includes(THEME.error), false);
	});
});
