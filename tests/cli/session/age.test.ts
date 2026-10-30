import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionAge } from "#src/cli/session/age.ts";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const ago = (ms: number): string => sessionAge(new Date(NOW - ms).toISOString(), NOW);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("会话时间的人话表示", () => {
	it("一分钟以内写 just now", () => {
		assert.equal(ago(0), "just now");
		assert.equal(ago(59_000), "just now");
	});

	it("分钟级向下取整，单数不带 s", () => {
		assert.equal(ago(MINUTE), "1 minute ago");
		assert.equal(ago(2 * MINUTE), "2 minutes ago");
		assert.equal(ago(59 * MINUTE), "59 minutes ago");
	});

	it("满一小时换成小时，满一天换成天", () => {
		assert.equal(ago(HOUR), "1 hour ago");
		assert.equal(ago(2 * HOUR), "2 hours ago");
		assert.equal(ago(23 * HOUR + 59 * MINUTE), "23 hours ago");
		assert.equal(ago(DAY), "1 day ago");
		assert.equal(ago(3 * DAY), "3 days ago");
	});

	it("满七天换成周，满五十二周换成年", () => {
		assert.equal(ago(7 * DAY), "1 week ago");
		assert.equal(ago(21 * DAY), "3 weeks ago");
		// 51 周仍是周，满 52 周就进到年
		assert.equal(ago(51 * 7 * DAY), "51 weeks ago");
		assert.equal(ago(52 * 7 * DAY), "1 year ago");
		assert.equal(ago(3 * 365 * DAY), "3 years ago");
	});

	it("时间解析不了或落在未来时不显示，不编造相对时间", () => {
		assert.equal(sessionAge("not a date", NOW), "");
		assert.equal(sessionAge(new Date(NOW + HOUR).toISOString(), NOW), "");
	});
});
