import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { showPage } from "../../../src/tui/runtime/pages.ts";
import type { TuiState } from "../../../src/tui/runtime/types.ts";

describe("整屏页", () => {
	it("打开整屏页会收掉 @ 补全面板与选区", () => {
		const state = {
			openPage: undefined,
			pageScrollTop: 5,
			pageCache: { kind: "help", width: 80, lines: [] },
			selection: { anchor: { line: 0, cell: 0 }, focus: { line: 1, cell: 0 } },
			fileMenu: {
				items: ["a.ts"],
				token: { start: 0, end: 3, query: "" },
				cursor: 0,
				scrollTop: 0,
			},
			fileFiles: ["a.ts"],
			fileIndexStart: 0,
		} as unknown as TuiState;

		showPage(state, "help");

		assert.equal(state.openPage, "help");
		assert.equal(state.pageScrollTop, 0);
		assert.equal(state.pageCache, undefined);
		assert.equal(state.fileMenu, undefined);
		assert.equal(state.fileFiles, undefined);
		assert.equal(state.fileIndexStart, undefined);
		assert.equal(state.selection, undefined);
	});
});
