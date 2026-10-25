import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CheckpointEntry } from "../../../src/checkpoint/service.ts";
import {
	CHECKPOINT_ACTION_HEIGHT,
	checkpointAge,
	checkpointListActions,
	checkpointListLines,
	checkpointPreviewActions,
	checkpointPreviewLines,
} from "../../../src/tui/page/checkpoint.ts";
import { displayWidth } from "../../../src/tui/render/text.ts";
import { THEME } from "../../../src/tui/render/theme.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const NOW = Date.now();
const TURN: CheckpointEntry = {
	id: "t2",
	turn: 2,
	createdAt: NOW - 60_000,
	kind: "turn",
	label: "Turn 2",
	changes: 3,
};
const SAFETY: CheckpointEntry = {
	id: "s1",
	turn: 1,
	createdAt: NOW - 120_000,
	kind: "safety",
	label: "Before undo of Turn 1",
	changes: 1,
};

describe("检查点页面", () => {
	it("列表显示选中项、文件数和相对时间", () => {
		const lines = checkpointListLines([TURN, SAFETY], 80, 0);

		assert.ok(plain(lines[0] ?? "").startsWith("Reins — checkpoints"));
		assert.ok(plain(lines[2] ?? "").includes("▸ Turn 2  3 files"));
		assert.ok(plain(lines[2] ?? "").includes("1m ago"));
		assert.ok(plain(lines[3] ?? "").includes("Before undo of Turn 1"));
		assert.ok(lines[3]?.includes(THEME.syntaxKeyword));
		assert.ok(plain(lines.join("\n")).includes("Last 20 checkpoints"));
		for (const line of lines) {
			assert.ok(displayWidth(plain(line)) <= 80);
		}
	});

	it("确认页列出 A/M/D 与恢复后果，底部动作固定", () => {
		const lines = checkpointPreviewLines(
			{
				entry: TURN,
				changes: [
					{ path: "src/a.ts", status: "modified" },
					{ path: "src/b.ts", status: "added" },
					{ path: "docs/c.md", status: "deleted" },
				],
			},
			60,
		);
		const text = plain(lines.join("\n"));

		assert.ok(text.includes("Reins — undo"));
		assert.ok(text.includes("M  src/a.ts"));
		assert.ok(text.includes("A  src/b.ts"));
		assert.ok(text.includes("D  docs/c.md"));
		assert.ok(text.includes("will be removed"));
		assert.ok(text.includes("will be restored"));
		assert.ok(text.includes("will be overwritten"));
		for (const line of lines) {
			assert.ok(displayWidth(plain(line)) <= 60);
		}

		const actions = checkpointPreviewActions(60, "turn");
		assert.equal(CHECKPOINT_ACTION_HEIGHT, 2);
		assert.equal(actions.length, 2);
		assert.ok(plain(actions[1] ?? "").includes("u undo these changes"));
		assert.ok(plain(actions[1] ?? "").includes("Esc cancel"));
	});

	it("没有变更与安全点的文案分开", () => {
		const empty = checkpointPreviewLines({ entry: TURN, changes: [] }, 60);
		assert.ok(plain(empty.join("\n")).includes("matches the current workspace"));

		const safety = checkpointPreviewActions(60, "safety");
		assert.ok(plain(safety[1] ?? "").includes("u restore this checkpoint"));

		const list = checkpointListActions(40);
		assert.ok(plain(list[1] ?? "").includes("Enter view & restore"));
	});

	it("时间描述覆盖分钟、小时与天", () => {
		assert.equal(checkpointAge(NOW - 5_000), "just now");
		assert.equal(checkpointAge(NOW - 90_000), "1m ago");
		assert.equal(checkpointAge(NOW - 2 * 3600_000), "2h ago");
		assert.equal(checkpointAge(NOW - 3 * 86400_000), "3d ago");
	});
});
