import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTranscriptView } from "../../../src/tui/transcript.ts";
import type { TranscriptTurn } from "../../../src/tui/transcript.ts";
import { currentTranscript, markTranscriptDirty } from "../../../src/tui/runtime/transcript-state.ts";
import type { TuiState } from "../../../src/tui/runtime/types.ts";

const WIDTH = 80;

/** 只填 currentTranscript 与 noticeText 会碰到的字段。 */
function stateOf(turns: TranscriptTurn[]): TuiState {
	return {
		turns,
		transcriptView: undefined,
		transcriptViewWidth: -1,
		transcriptViewNotice: undefined,
		transcriptDirty: true,
		transcriptPrefix: undefined,
		sandboxNotice: undefined,
		activeWarning: undefined,
	} as never;
}

function turnOf(prompt: string, text: string): TranscriptTurn {
	return { prompt, response: [{ kind: "markdown", text }] };
}

/** 增量构建的结果必须与全量逐行一致，否则界面上会出现错位或重复。 */
function assertSameAsFull(
	state: TuiState,
	turns: readonly TranscriptTurn[],
	notice?: string,
): void {
	const incremental = currentTranscript(state, WIDTH);
	const full = buildTranscriptView(WIDTH, turns, notice);
	assert.deepEqual(incremental.lines, full.lines);
}

describe("对话流视图缓存", () => {
	it("追加回合后增量构建与全量一致", () => {
		const turns = [turnOf("q1", "a1"), turnOf("q2", "a2")];
		const state = stateOf(turns);
		assertSameAsFull(state, turns);

		turns.push(turnOf("q3", "a3"));
		markTranscriptDirty(state);
		assertSameAsFull(state, turns);

		turns.push(turnOf("q4", "a4"));
		markTranscriptDirty(state);
		assertSameAsFull(state, turns);
	});

	it("最后一个回合流式变化时只重排它，结果仍与全量一致", () => {
		const turns = [turnOf("q1", "a1"), turnOf("q2", "a2")];
		const state = stateOf(turns);
		assertSameAsFull(state, turns);

		// 流式追加：同一个回合换成新对象
		turns[1] = turnOf("q2", "a2 and more");
		markTranscriptDirty(state);
		assertSameAsFull(state, turns);
	});

	it("宽度变化时前缀失效，结果与全量一致", () => {
		const turns = [turnOf("q1", "a1"), turnOf("q2", "a2")];
		const state = stateOf(turns);
		currentTranscript(state, WIDTH);

		markTranscriptDirty(state);
		const narrow = currentTranscript(state, 40);
		assert.deepEqual(narrow.lines, buildTranscriptView(40, turns).lines);
	});

	it("前面的回合被换掉时重新构建，不会沿用旧前缀", () => {
		const turns = [turnOf("q1", "a1"), turnOf("q2", "a2"), turnOf("q3", "a3")];
		const state = stateOf(turns);
		assertSameAsFull(state, turns);

		turns[0] = turnOf("q1", "a1 rewritten");
		markTranscriptDirty(state);
		assertSameAsFull(state, turns);
	});

	it("警告文本变化时重新构建", () => {
		const turns = [turnOf("q1", "a1"), turnOf("q2", "a2")];
		const state = stateOf(turns);
		assertSameAsFull(state, turns);

		(state as unknown as { activeWarning: string }).activeWarning = "sandbox is off";
		markTranscriptDirty(state);
		assertSameAsFull(state, turns, "sandbox is off");
	});
});
