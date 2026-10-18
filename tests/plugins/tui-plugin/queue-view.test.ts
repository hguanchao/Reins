import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_QUEUE_ROWS, queueRows } from "../../../src/plugins/tui-plugin/queue-view.ts";
import { lineText } from "../../../src/tui/text/line.ts";

describe("排队消息", () => {
	it("空队列不产生行", () => {
		assert.deepEqual(queueRows([], 80), []);
	});

	it("按顺序编号，多行消息标出剩余行数", () => {
		const rows = queueRows(["first", "one\ntwo\nthree"], 80).map(lineText);
		assert.equal(rows.length, 2);
		assert.ok(rows[0].includes("#1 first"), rows[0]);
		assert.ok(rows[1].includes("#2 one"), rows[1]);
		assert.ok(rows[1].includes("(+2 lines)"), rows[1]);
	});

	it("超过上限时保留前几条，最后一行说明还有多少", () => {
		const rows = queueRows(["a", "b", "c", "d", "e"], 80).map(lineText);
		assert.equal(rows.length, MAX_QUEUE_ROWS);
		assert.ok(rows[0].includes("#1 a"));
		assert.ok(rows[1].includes("#2 b"));
		assert.ok(rows[2].includes("… 3 more queued"), rows[2]);
	});

	it("长消息按宽度截断", () => {
		const rows = queueRows(["x".repeat(200)], 40).map(lineText);
		assert.ok(rows[0].includes("…"));
		assert.ok(rows[0].length <= 40, String(rows[0].length));
	});
});
