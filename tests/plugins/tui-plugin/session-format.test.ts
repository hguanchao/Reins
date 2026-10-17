import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { copyNotice, fullTimestamp } from "../../../src/plugins/tui-plugin/session-format.ts";

describe("会话提示文字", () => {
	it("完整日期带年月日与 12 小时时间", () => {
		const morning = new Date(2026, 9, 17, 9, 5).getTime();
		const afternoon = new Date(2026, 9, 17, 14, 33).getTime();
		assert.equal(fullTimestamp(morning), "2026-10-17 9:05 AM");
		assert.equal(fullTimestamp(afternoon), "2026-10-17 2:33 PM");
	});

	it("复制提示带字符数与行数", () => {
		assert.equal(
			copyNotice({ delivery: "confirmed", message: "Copied!" }, "hello"),
			"Copied! (5 chars, 1 line)",
		);
		assert.equal(
			copyNotice({ delivery: "confirmed", message: "Copied!" }, "a\nb"),
			"Copied! (3 chars, 2 lines)",
		);
	});
});
