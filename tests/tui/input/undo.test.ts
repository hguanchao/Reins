import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_UNDO_ENTRIES,
	TYPE_RUN_WINDOW_MS,
	popUndo,
	recordUndo,
	type InputSnapshot,
	type UndoEntry,
} from "#src/tui/input/undo.ts";

function snap(text: string, cursor: number = text.length): InputSnapshot {
	return { text, cursor, images: [] };
}

describe("撤销栈", () => {
	it("每次编辑压入编辑前的状态", () => {
		let stack: readonly UndoEntry[] = [];
		stack = recordUndo(stack, snap(""), { text: "a", cursor: 1 }, 0);
		stack = recordUndo(stack, snap("a"), { text: "ab", cursor: 2 }, TYPE_RUN_WINDOW_MS + 1);
		assert.equal(stack.length, 2);
		const popped = popUndo(stack);
		assert.equal(popped?.snapshot.text, "a");
		assert.equal(popUndo(popped.rest)?.snapshot.text, "");
	});

	it("窗口内的连打合并成一步", () => {
		let stack: readonly UndoEntry[] = [];
		stack = recordUndo(stack, snap(""), { text: "a", cursor: 1 }, 0);
		stack = recordUndo(stack, snap("a"), { text: "ab", cursor: 2 }, TYPE_RUN_WINDOW_MS - 1);
		stack = recordUndo(stack, snap("ab"), { text: "abc", cursor: 3 }, TYPE_RUN_WINDOW_MS);
		assert.equal(stack.length, 1);
		assert.equal(popUndo(stack)?.snapshot.text, "");
	});

	it("超过窗口或反向编辑都不合并", () => {
		let stack: readonly UndoEntry[] = [];
		stack = recordUndo(stack, snap(""), { text: "a", cursor: 1 }, 0);
		// 超过时间窗：新的连打另起一步
		stack = recordUndo(stack, snap("a"), { text: "ab", cursor: 2 }, TYPE_RUN_WINDOW_MS + 1);
		assert.equal(stack.length, 2);
		// 反向：退格单独成步
		stack = recordUndo(stack, snap("ab"), { text: "a", cursor: 1 }, TYPE_RUN_WINDOW_MS + 2);
		assert.equal(stack.length, 3);
		assert.equal(popUndo(stack)?.snapshot.text, "ab");
	});

	it("多字符改动不参与合并", () => {
		let stack: readonly UndoEntry[] = [];
		// 粘贴/多字输入自成一步；紧随其后的单字符追加也不与它合并
		stack = recordUndo(stack, snap("hello "), { text: "hello world", cursor: 11 }, 0);
		stack = recordUndo(stack, snap("hello world"), { text: "hello world!", cursor: 12 }, 1);
		assert.equal(stack.length, 2);
		assert.equal(popUndo(stack)?.snapshot.text, "hello world");
	});

	it("窗口内的连删合并成一步", () => {
		let stack: readonly UndoEntry[] = [];
		stack = recordUndo(stack, snap("abc"), { text: "ab", cursor: 2 }, 0);
		stack = recordUndo(stack, snap("ab"), { text: "a", cursor: 1 }, 1);
		assert.equal(stack.length, 1);
		assert.equal(popUndo(stack)?.snapshot.text, "abc");
	});

	it("栈深封顶，最老的先淘汰", () => {
		let stack: readonly UndoEntry[] = [];
		for (let index = 0; index < MAX_UNDO_ENTRIES + 5; index += 1) {
			stack = recordUndo(
				stack,
				snap(`t${index}`),
				{ text: `t${index}x`, cursor: index + 2 },
				index * (TYPE_RUN_WINDOW_MS + 1),
			);
		}
		assert.equal(stack.length, MAX_UNDO_ENTRIES);
		assert.equal(popUndo(stack)?.snapshot.text, `t${MAX_UNDO_ENTRIES + 4}`);
	});

	it("空栈弹不出", () => {
		assert.equal(popUndo([]), undefined);
	});
});
