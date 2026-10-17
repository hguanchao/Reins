import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { copyNotice, fullTimestamp } from "../../../src/plugins/tui-plugin/session-format.ts";

describe("会话提示文字", () => {
	it("完整日期是 24 小时制到秒，月份用缩写", () => {
		const morning = new Date(2026, 9, 17, 9, 5).getTime();
		const afternoon = new Date(2026, 9, 17, 14, 33).getTime();
		assert.equal(fullTimestamp(morning), "09:05:00 | Oct 17");
		assert.equal(fullTimestamp(afternoon), "14:33:00 | Oct 17");
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
