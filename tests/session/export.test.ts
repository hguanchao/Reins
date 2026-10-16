import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderSessionMarkdown } from "../../src/session/export.ts";
import type { SessionEntry, SessionHeaderEntry } from "../../src/session/port.ts";
import { describeUsage, sumUsage } from "../../src/session/usage.ts";

/**
 * 用量统计与导出。
 *
 * 两条要点：被压缩掉的历史仍要计入用量（那些 token 确实花掉了），导出的是完整历史而不是
 * 当前上下文（压缩点单独标出来，读的人才分得清「模型看到什么」与「当时发生了什么」）。
 */

function usageEntry(
	id: string,
	kind: "turn" | "compact" | "subagent",
	total: number,
	cost?: number,
): SessionEntry {
	return {
		type: "usage",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		provider: "p",
		model: "m",
		kind,
		usage: { input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, total },
		cost,
	};
}

function message(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content },
	};
}

describe("用量统计", () => {
	it("把所有用量条目加在一起，含压缩那次", () => {
		const totals = sumUsage([usageEntry("1", "turn", 100), usageEntry("2", "compact", 50), usageEntry("3", "turn", 30)]);
		assert.equal(totals.requests, 3);
		assert.equal(totals.compactions, 1);
		assert.equal(totals.total, 180);
		assert.equal(totals.output, 30);
	});

	it("被压缩掉的历史仍计入：压缩只改变接下来的请求，不改变已经花掉的", () => {
		const compaction: SessionEntry = {
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp: "2026-01-01T00:00:02.000Z",
			summary: "摘要",
			covered: ["1"],
			provider: "p",
			model: "m",
			tokensBefore: 900,
			usage: undefined,
		};
		const totals = sumUsage([usageEntry("1", "turn", 900), message("m1", "甲"), compaction]);
		assert.equal(totals.total, 900);
	});

	it("没有用量条目时全为零，不编造数字", () => {
		assert.deepEqual(sumUsage([message("m1", "甲")]), {
			requests: 0,
			compactions: 0,
			subagents: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: undefined,
			unpriced: 0,
		});
	});

	it("汇总写成人看的一行", () => {
		const text = describeUsage(sumUsage([usageEntry("1", "turn", 100), usageEntry("2", "compact", 50)]));
		assert.ok(text.includes("请求 2 次（其中压缩 1 次）"));
		assert.ok(text.includes("合计 150 token"));
		// 一笔单价都没有时不出现金额：一个 $0 会被读成「没花钱」
		assert.ok(!text.includes("费用"));
	});

	it("配了单价就报金额", () => {
		const text = describeUsage(sumUsage([usageEntry("1", "turn", 100, 0.0123), usageEntry("2", "turn", 50, 0.0001)]));

		assert.ok(text.includes("费用 $0.0124"), text);
		assert.ok(!text.includes("未配单价"), text);
	});

	it("只有部分请求配了单价时，金额只算配了的，并说明有几笔没算", () => {
		const totals = sumUsage([usageEntry("1", "turn", 100, 0.5), usageEntry("2", "turn", 50), usageEntry("3", "turn", 30)]);

		assert.equal(totals.cost, 0.5);
		assert.equal(totals.unpriced, 2);
		const text = describeUsage(totals);
		assert.ok(text.includes("费用 $0.5000"), text);
		assert.ok(text.includes("另有 2 次未配单价，未计入"), text);
	});

	it("小额金额用更多小数位，不显示成 0", () => {
		const text = describeUsage(sumUsage([usageEntry("1", "turn", 100, 0.000012)]));
		assert.ok(text.includes("费用 $0.000012"), text);
	});
});

describe("导出成 Markdown", () => {
	const header: SessionHeaderEntry = {
		type: "session",
		version: 1,
		id: "aaaa1111",
		timestamp: "2026-10-16T02:00:00.000Z",
		cwd: "E:\\Projects\\Reins",
		forkedFrom: { session: "bbbb2222", entry: "e0" },
	};

	it("带上出处、目录与用量", () => {
		const text = renderSessionMarkdown(header, [message("1", "把配置改一下"), usageEntry("2", "turn", 120)]);
		assert.ok(text.startsWith("# 会话 aaaa1111"));
		assert.ok(text.includes("- 分叉自：bbbb2222 的 e0"));
		assert.ok(text.includes("- 目录：E:\\Projects\\Reins"));
		assert.ok(text.includes("## 用量"));
		assert.ok(text.includes("合计 120 token"));
	});

	it("使用者、助手与工具结果各成一块，工具结果按引用块排", () => {
		const entries: SessionEntry[] = [
			message("1", "读一下 a.ts"),
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "我来读。" },
						{ type: "thinking", text: "先看文件" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
					],
				},
			},
			{
				type: "message",
				id: "3",
				parentId: "2",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: "第一行\n第二行", isError: false },
			},
		];
		const text = renderSessionMarkdown(header, entries);

		assert.ok(text.includes("### 使用者"));
		assert.ok(text.includes("### 助手"));
		assert.ok(text.includes("我来读。"));
		assert.ok(text.includes("> **思考**"));
		assert.ok(text.includes('调用工具 `read`：'));
		assert.ok(text.includes("### 工具结果 read"));
		// 多行内容按行加前缀，围栏或缩进都不会把它截断
		assert.ok(text.includes("> 第一行\n> 第二行"));
	});

	it("压缩点标出来，并附上摘要全文", () => {
		const entries: SessionEntry[] = [
			message("1", "甲"),
			{
				type: "compaction",
				id: "2",
				parentId: "1",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: "先前读了 a.ts，内容正常。",
				covered: ["1"],
				provider: "p",
				model: "compact-model",
				tokensBefore: 9000,
				usage: undefined,
			},
			message("3", "接着来"),
		];
		const text = renderSessionMarkdown(header, entries);

		assert.ok(text.includes("> 上下文压缩：覆盖 1 条消息，详情见后文"));
		assert.ok(text.includes("## 上下文压缩"));
		assert.ok(text.includes("覆盖 1 条消息，压缩前约 9000 token。"));
		assert.ok(text.includes("先前读了 a.ts，内容正常。"));
		// 被压缩掉的消息仍在正文里：导出的是完整历史
		assert.ok(text.includes("### 使用者"));
		assert.ok(text.includes("甲"));
		assert.ok(text.includes("接着来"));
	});

	it("空的会话也导得出来", () => {
		const text = renderSessionMarkdown(undefined, []);
		assert.ok(text.includes("（缺少会话头）"));
		assert.ok(text.includes("（还没有对话）"));
	});
});
