import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	agentLine,
	blockLine,
	pulseStyle,
	rail,
} from "../../../src/plugins/tui-plugin/transcript-style.ts";
import { lineText, plain } from "../../../src/tui/text/line.ts";

describe("块行样式", () => {
	it("有颜色时画竖线，没有颜色时空一格", () => {
		assert.equal(lineText(rail({ color: "red" })), "┃");
		assert.equal(lineText(rail(undefined)), " ");
	});

	it("块行保留竖线与左留白", () => {
		assert.equal(lineText(blockLine(plain("┃"), plain("body"))), "┃  body");
		assert.equal(lineText(agentLine(plain("body"))), "   body");
		assert.deepEqual(agentLine([]), []);
	});

	it("运行中强调色随时间与行号变化", () => {
		const first = pulseStyle(0, 0);
		assert.notDeepEqual(first, pulseStyle(120, 0));
		assert.notDeepEqual(first, pulseStyle(0, 2));
		assert.ok(Array.isArray(first.color));
	});

	it("竖线样式保留在块行里", () => {
		const line = blockLine(rail({ color: "red" }), plain("x"));
		assert.equal(lineText(line), "┃  x");
		assert.equal(line[0].style?.color, "red");
	});
});
