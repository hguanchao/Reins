import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toastLine } from "../../../src/plugins/tui-plugin/toast.ts";
import { THEME } from "../../../src/plugins/tui-plugin/theme.ts";
import { lineText, lineWidth, plain } from "../../../src/tui/text/line.ts";

describe("临时提示", () => {
	it("贴右缘覆盖在会话行上，整行宽度不变", () => {
		const line = plain("x".repeat(40));
		const toast = toastLine(line, 40, "Copied!");
		assert.equal(lineWidth(toast), 40);
		assert.equal(lineText(toast), `${"x".repeat(31)} Copied! `);
		const span = toast.find((item) => item.text.includes("Copied!"));
		assert.equal(span?.style?.background, THEME.base);
		assert.equal(span?.style?.bold, true);
	});

	it("提示比整行还长时截断，不越界", () => {
		const toast = toastLine(plain("x".repeat(10)), 10, "a very long notice");
		assert.equal(lineWidth(toast), 10);
	});

	it("空提示保持原行", () => {
		const line = plain("unchanged");
		assert.equal(toastLine(line, 20, ""), line);
	});

	it("底行是空行时也贴右缘", () => {
		assert.equal(lineText(toastLine([], 20, "hi")), `${" ".repeat(16)} hi `);
	});
});
