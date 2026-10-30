import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { todoTool } from "#src/tools/builtin/todo.ts";

describe("任务列表工具", () => {
	const run = (args: unknown) =>
		todoTool.execute({
			callId: "1",
			args: args as never,
			signal: new AbortController().signal,
			onUpdate: () => {},
			workspace: {} as never,
			sandbox: {} as never,
			session: { id: "s", path: null } as never,
		});

	it("回执里给出完成计数", async () => {
		const result = await run({
			todos: [
				{ content: "写工具", status: "completed" },
				{ content: "写界面", status: "completed" },
				{ content: "补测试", status: "in_progress" },
				{ content: "提交", status: "pending" },
				{ content: "修跨平台路径", status: "failed" },
			],
		});

		assert.equal(result.content, "Task list updated: 2 of 5 done.");
		assert.equal(result.isError, undefined);
	});

	it("空数组表示清空列表", async () => {
		const result = await run({ todos: [] });

		assert.equal(result.content, "Task list cleared.");
	});

	it("空白内容直接拒绝,不猜一个能跑的形状", async () => {
		const result = await run({
			todos: [
				{ content: "正常任务", status: "pending" },
				{ content: "   ", status: "in_progress" },
			],
		});

		assert.equal(result.isError, true);
		assert.ok(result.content.includes("non-empty"));
	});

	it("描述给出多步边界、整表更新与收尾规则", () => {
		assert.ok(todoTool.description.includes("three or more distinct steps"));
		assert.ok(todoTool.description.includes("COMPLETE current list"));
		assert.ok(todoTool.description.includes("exactly one task in_progress"));
		assert.ok(todoTool.description.includes("finish with every task completed or failed"));
	});

	it("只读标注:它只与对话内容交互,不需要审批", () => {
		assert.deepEqual(todoTool.annotations, { readOnly: true, destructive: false, openWorld: false });
	});
});
