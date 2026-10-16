import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldEntries } from "../../src/session/fold.ts";
import type { SessionEntry } from "../../src/session/port.ts";
import { Session } from "../../src/session/session.ts";

/**
 * 折叠规则。
 *
 * 这些用例盯的是「下一次请求要用的东西全部来自条目」这条约定：分段是增量、工具声明是增量、
 * 移除与替换都要能在重放时生效。
 */

function base(id: string, parentId: string | null): { id: string; parentId: string | null; timestamp: string } {
	return { id, parentId, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("会话折叠", () => {
	it("分段按增量叠加，值为 null 表示移除那一段", () => {
		const entries: SessionEntry[] = [
			{ type: "system", ...base("1", null), sections: { preamble: "开头", rules: "规则" } },
			{ type: "system", ...base("2", "1"), sections: { rules: null, cwd: "工作区" } },
		];
		assert.deepEqual(foldEntries(entries).sections, { preamble: "开头", cwd: "工作区" });
	});

	it("工具声明按名字替换与移除，顺序跟着声明走", () => {
		const entries: SessionEntry[] = [
			{
				type: "system",
				...base("1", null),
				sections: {},
				toolsAdded: [
					{ name: "read", description: "旧说明", parameters: {} },
					{ name: "bash", description: "跑命令", parameters: {} },
				],
			},
			{
				type: "system",
				...base("2", "1"),
				sections: {},
				toolsRemoved: ["bash"],
				toolsAdded: [{ name: "read", description: "新说明", parameters: {} }],
			},
		];
		const tools = foldEntries(entries).tools;
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, "read");
		assert.equal(tools[0].description, "新说明");
	});

	it("模型与思考等级取最后一次变更", () => {
		const entries: SessionEntry[] = [
			{ type: "model_change", ...base("1", null), provider: "p", model: "a" },
			{ type: "effort_change", ...base("2", "1"), effort: "low" },
			{ type: "model_change", ...base("3", "2"), provider: "p", model: "b" },
		];
		const state = foldEntries(entries);
		assert.deepEqual(state.model, { provider: "p", model: "b" });
		assert.equal(state.effort, "low");
	});

	it("消息按写入顺序进入上下文", async () => {
		const session = new Session({ id: "s", cwd: "/work", file: null });
		await session.append({ type: "message", message: { role: "user", content: "甲" } });
		await session.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "乙" }] } });

		assert.deepEqual(session.state().messages, [
			{ role: "user", content: "甲" },
			{ role: "assistant", content: [{ type: "text", text: "乙" }] },
		]);
		assert.deepEqual(foldEntries(session.entries()), session.state());
	});
});
