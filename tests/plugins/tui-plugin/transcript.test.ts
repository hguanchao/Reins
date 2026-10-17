import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Transcript } from "../../../src/plugins/tui-plugin/transcript.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("用户消息", () => {
	it("单行消息占三行，正文在中间", () => {
		const transcript = new Transcript(40);
		const lines = transcript.userTurn("hello");

		assert.equal(lines.length, 3);
		assert.equal(lineText(lines[1]), `hello${" ".repeat(35)}`);
		assert.equal(lineText(lines[0]).trim(), "");
		assert.equal(lineText(lines[2]).trim(), "");
	});

	it("不带提示符前缀，正文从第一列开始", () => {
		const transcript = new Transcript(40);
		const lines = transcript.userTurn("hello");

		assert.ok(!lines.some((line) => lineText(line).includes("›")));
		assert.ok(lineText(lines[1]).startsWith("hello"));
	});

	it("整块铺底，每行都填满会话宽度", () => {
		const transcript = new Transcript(40);
		const lines = transcript.userTurn("hello");

		for (const line of lines) {
			assert.equal(lineWidth(line), 40);
			assert.ok(line.every((span) => span.style?.background !== undefined), "banded");
		}
	});

	it("多行消息上下各留一行，正文不截断也不缩进", () => {
		const transcript = new Transcript(10);
		const lines = transcript.userTurn("one two three four");

		assert.ok(lines.length > 3, "message wrapped");
		assert.equal(lineText(lines[0]).trim(), "");
		assert.equal(lineText(lines[lines.length - 1]).trim(), "");
		for (const line of lines.slice(1, -1)) {
			assert.equal(lineText(line), lineText(line).trimStart());
			assert.ok(line.every((span) => span.style?.background !== undefined), "banded");
		}
	});
});
