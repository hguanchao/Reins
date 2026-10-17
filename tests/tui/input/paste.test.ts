import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PASTE_CHIP_MAX_BYTES, pasteChipLabel, pasteLineCount } from "../../../src/tui/input/paste.ts";

describe("粘贴内容统计", () => {
	it("末尾换行不额外算一行", () => {
		assert.equal(pasteLineCount(""), 0);
		assert.equal(pasteLineCount("hello"), 1);
		assert.equal(pasteLineCount("hello\n"), 1);
		assert.equal(pasteLineCount("a\n\n"), 2);
		assert.equal(pasteLineCount("a\nb\nc"), 3);
	});
});

describe("粘贴 chip 阈值", () => {
	it("短文本直接内联", () => {
		assert.equal(pasteChipLabel("hello"), undefined);
		assert.equal(pasteChipLabel("a\nb\nc"), undefined);
	});

	it("达到四行折成 chip，标签带行数", () => {
		assert.equal(pasteChipLabel("a\nb\nc\nd"), "[Pasted: 4 lines]");
		assert.equal(pasteChipLabel("a\nb\nc\nd\n"), "[Pasted: 4 lines]");
	});

	it("超过字节上限时优先显示大小", () => {
		const text = "x".repeat(PASTE_CHIP_MAX_BYTES + 1);
		assert.equal(pasteChipLabel(text), "[Pasted: 10 KB]");
		assert.equal(pasteChipLabel("x".repeat(1_000_001)), "[Pasted: 1.0 MB]");
	});
});
