import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	createPasteStore,
	expandPaste,
	expandPastes,
	highlightPasteMarkers,
	markerAtColumn,
	pasteInsertion,
	pasteLineCount,
	pasteMarkerOf,
	shouldCollapsePaste,
} from "#src/tui/paste.ts";

describe("折叠粘贴", () => {
	it("四行或 10 KB 以上才折叠，短粘贴保持原样", () => {
		assert.equal(shouldCollapsePaste("a\nb\nc"), false);
		assert.equal(shouldCollapsePaste("a\nb\nc\nd"), true);
		// 单行也算：压缩过的一行 JSON 同样会把输入框撑爆
		assert.equal(shouldCollapsePaste("x".repeat(9_990)), false);
		assert.equal(shouldCollapsePaste("x".repeat(10_001)), true);
	});

	it("行数不把末尾换行算成额外一行", () => {
		assert.equal(pasteLineCount("a"), 1);
		assert.equal(pasteLineCount("a\n"), 1);
		assert.equal(pasteLineCount("a\nb\n"), 2);
		assert.equal(pasteLineCount(""), 0);
	});

	it("标记按行数或体积给标签", () => {
		assert.equal(pasteMarkerOf(1, "a\nb\nc\nd"), "[Pasted #1: 4 lines]");
		assert.equal(pasteMarkerOf(2, "x".repeat(12_000)), "[Pasted #2: 12 KB]");
		assert.equal(pasteMarkerOf(3, "x".repeat(1_200_000)), "[Pasted #3: 1.2 MB]");
	});

	it("首次粘贴折叠成标记，原文留在会话里", () => {
		const store = createPasteStore();
		const text = "a\nb\nc\nd";
		const insertion = pasteInsertion(store, text, "");

		assert.equal(insertion.insert, "[Pasted #1: 4 lines]");
		assert.equal(insertion.removeBefore, 0);
		assert.equal(store.entries.get(1), text);
	});

	it("紧贴已有标记再贴同一段内容就展开原文", () => {
		const store = createPasteStore();
		const text = "a\nb\nc\nd";
		const marker = pasteInsertion(store, text, "").insert;

		const expanded = pasteInsertion(store, text, `前缀 ${marker}`);
		assert.equal(expanded.insert, text);
		// 展开时要连同那行标记一起删掉，否则会留下一个孤儿标记
		assert.equal(expanded.removeBefore, marker.length);
	});

	it("同样的内容贴到别处仍是新标记", () => {
		const store = createPasteStore();
		const text = "a\nb\nc\nd";
		pasteInsertion(store, text, "");

		assert.equal(pasteInsertion(store, text, "另一处 ").insert, "[Pasted #2: 4 lines]");
	});

	it("发送时只还原登记过的标记", () => {
		const store = createPasteStore();
		const text = "a\nb\nc\nd";
		const marker = pasteInsertion(store, text, "").insert;

		assert.equal(expandPastes(store, `看下 ${marker} 是什么`), `看下 ${text} 是什么`);
		// 手打出同样字样、或标记被改了半截：不猜，按普通文字发出去
		assert.equal(expandPastes(store, "[Pasted #9: 4 lines]"), "[Pasted #9: 4 lines]");
	});

	it("按显示宽度定位标记：前面的中文不会把列算错", () => {
		const line = "中文[Pasted #3: 5 lines]尾巴";
		assert.equal(markerAtColumn(line, 3), undefined);
		assert.equal(markerAtColumn(line, 4), 3);
		assert.equal(markerAtColumn(line, 23), 3);
		assert.equal(markerAtColumn(line, 24), undefined);
	});

	it("展开把标记换回原文，光标落在原文末尾", () => {
		const store = createPasteStore();
		const text = "a\nb\nc\nd";
		const marker = pasteInsertion(store, text, "").insert;
		const expanded = expandPaste(store, `前 ${marker} 后`, 1);
		assert.ok(expanded);
		assert.equal(expanded.text, `前 ${text} 后`);
		assert.equal(expanded.cursor, 9);
		// 展开过的标记已经出表，再点也不会重复插入
		assert.equal(expandPaste(store, expanded.text, 1), undefined);
	});

	it("标记上色只改颜色不改文字", () => {
		assert.equal(
			highlightPasteMarkers("a [Pasted #1: 4 lines] b", "<c>", "</>"),
			"a <c>[Pasted #1: 4 lines]</> b",
		);
	});
});
