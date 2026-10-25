import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEME } from "../../../src/tui/render/theme.ts";
import { renderTranscript } from "../../../src/tui/transcript.ts";
import type { TranscriptTurn } from "../../../src/tui/transcript.ts";

const PROMPT_BG = "\x1b[48;2;22;25;29m";
const MESSAGE_TEXT = "\x1b[38;2;230;233;237m";

function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("用户提示块", () => {
	it("图片标记用引用蓝高亮，背景与正文颜色保持", () => {
		const turn: TranscriptTurn = { prompt: "[image: a.png] 这是什么", response: [] };
		const line =
			renderTranscript(60, 10, [turn], 0).find((item) =>
				plain(item).includes("[image: a.png]"),
			) ?? "";

		assert.ok(line.includes(`${THEME.image}[image: a.png]${MESSAGE_TEXT}`));
		assert.ok(line.startsWith(PROMPT_BG));
		assert.ok(line.includes(`${MESSAGE_TEXT} 这是什么`));
	});
});
