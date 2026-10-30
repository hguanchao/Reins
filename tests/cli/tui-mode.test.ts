import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { terminalUnsupportedReason } from "#src/cli/tui-mode.ts";

describe("终端能力", () => {
	it("TERM=dumb 时拒绝进入全屏界面", () => {
		assert.match(terminalUnsupportedReason({ TERM: "dumb" }) ?? "", /ANSI/);
	});

	it("普通终端与未设置 TERM 时放行", () => {
		assert.equal(terminalUnsupportedReason({ TERM: "xterm-256color" }), undefined);
		assert.equal(terminalUnsupportedReason({}), undefined);
	});
});
