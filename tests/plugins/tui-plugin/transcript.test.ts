import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Transcript } from "../../../src/plugins/tui-plugin/transcript.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("用户消息", () => {
	it("单行消息占三行，正文在中间", () => {
		const transcript = new Transcript(40);
		const lines = transcript.userTurn("hello", 40);

		assert.equal(lines.length, 3);
		assert.equal(lineText(lines[1]), `› hello${" ".repeat(33)}`);
		assert.equal(lineText(lines[0]).trim(), "");
		assert.equal(lineText(lines[2]).trim(), "");
	});

	it("带 › 前缀，提示符贴住块左缘", () => {
		const transcript = new Transcript(40);
		const lines = transcript.userTurn("hello", 40);

		assert.ok(lineText(lines[1]).startsWith("› hello"));
		assert.ok(!lineText(lines[1]).startsWith(" "));
	});

	it("整块铺底，每行都填满给定宽度", () => {
		const transcript = new Transcript(40);
		const lines = transcript.userTurn("hello", 40);

		for (const line of lines) {
			assert.equal(lineWidth(line), 40);
			assert.ok(line.every((span) => span.style?.background !== undefined), "banded");
		}
	});

	it("多行消息上下各留一行，正文不截断，续行与提示符后的正文对齐", () => {
		const transcript = new Transcript(10);
		const lines = transcript.userTurn("one two three four", 10);

		assert.ok(lines.length > 3, "message wrapped");
		assert.equal(lineText(lines[0]).trim(), "");
		assert.equal(lineText(lines[lines.length - 1]).trim(), "");
		const content = lines.slice(1, -1).map(lineText);
		assert.ok(content[0].startsWith("› "), "first line starts with the prompt");
		for (const line of content.slice(1)) assert.ok(line.startsWith("  "), "continuation aligns after the prompt");
		assert.ok(content.join("").includes("three"));
		assert.ok(content.join("").includes("four"));
	});
});
