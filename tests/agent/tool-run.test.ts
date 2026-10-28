import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rejectToolCalls, runToolCalls, type ToolRunDeps, type ToolRunEnd } from "../../src/agent/tool-run.ts";
import type { LlmToolCallBlock } from "../../src/llm/messages.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { AnyToolDefinition, ToolResult } from "../../src/tools/contract.ts";
import { TRUNCATED_TOOL_ARGUMENTS } from "../../src/agent/request.ts";

const SIGNAL = new AbortController().signal;

function call(id: string, name: string, args: Record<string, unknown> = {}): LlmToolCallBlock {
	return { type: "toolCall", id, name, arguments: args };
}

function tool(
	name: string,
	execute: (args: Record<string, unknown>) => Promise<ToolResult>,
	readOnly = true,
): AnyToolDefinition {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		annotations: { readOnly, destructive: false, openWorld: false },
		execute: async (context) => execute(context.args),
	};
}

function registryOf(...tools: readonly AnyToolDefinition[]): ToolRegistry {
	const registry = new ToolRegistry(new ResultSpiller(0, ""), {
		check: async () => ({ allowed: true, reason: "" }),
	});
	for (const item of tools) registry.register(item, "core");
	return registry;
}

interface Harness {
	readonly deps: ToolRunDeps;
	readonly written: readonly { callId: string; content: string; isError: boolean }[];
	readonly ends: readonly ToolRunEnd[];
	readonly starts: readonly string[];
}

function harness(registry: ToolRegistry, overrides: Partial<ToolRunDeps> = {}): Harness {
	const written: { callId: string; content: string; isError: boolean }[] = [];
	const ends: ToolRunEnd[] = [];
	const starts: string[] = [];
	const deps: ToolRunDeps = {
		tools: registry,
		run: {
			workspace: { root: "E:/w" } as never,
			sandbox: {} as never,
			session: { id: "s", path: null },
			signal: SIGNAL,
		},
		write: async (outcome) => {
			written.push({
				callId: outcome.callId,
				content: outcome.content,
				isError: outcome.isError,
			});
		},
		reporting: {
			start: (item) => {
				starts.push(item.id);
			},
			end: (outcome) => {
				ends.push(outcome);
			},
		},
		...overrides,
	};
	return { deps, written, ends, starts };
}

describe("工具编排", () => {
	it("按模型给出的顺序写回，即使完成次序相反", async () => {
		const slowFirst = tool("slow", async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { content: "slow-done" };
		});
		const fastSecond = tool("fast", async () => ({ content: "fast-done" }));
		const h = harness(registryOf(slowFirst, fastSecond));

		await runToolCalls([call("1", "slow"), call("2", "fast")], h.deps);

		assert.deepEqual(
			h.written.map((item) => item.callId),
			["1", "2"],
		);
		assert.deepEqual(h.starts, ["1", "2"]);
		// 结束事件按完成次序到达，写回顺序不受影响
		assert.equal(h.ends.length, 2);
	});

	it("单次调用抛错不影响其它调用，并作为错误结果写回", async () => {
		const broken = tool("broken", async () => {
			throw new Error("内部炸了");
		});
		const fine = tool("fine", async () => ({ content: "ok" }));
		const h = harness(registryOf(broken, fine));

		await runToolCalls([call("1", "broken"), call("2", "fine")], h.deps);

		assert.equal(h.written.length, 2);
		// 注册表本身把工具异常转成错误结果，因此这里看到的是它的固定措辞
		assert.match(h.written[0]?.content ?? "", /内部炸了/);
		assert.equal(h.written[0]?.isError, true);
		assert.equal(h.written[1]?.content, "ok");
	});

	it("参数不是合法 JSON 时也发调用行，并以错误结果写回", async () => {
		const h = harness(registryOf());
		const bad: LlmToolCallBlock = {
			type: "toolCall",
			id: "1",
			name: "read",
			arguments: {},
			argumentsError: "arguments are not valid JSON",
		};

		await runToolCalls([bad], h.deps);

		assert.deepEqual(h.starts, ["1"]);
		assert.equal(h.written[0]?.isError, true);
		assert.equal(h.written[0]?.content, "arguments are not valid JSON");
		assert.equal(h.ends[0]?.executed, true);
	});

	it("审批拒绝时结束事件标成未执行", async () => {
		const registry = new ToolRegistry(new ResultSpiller(0, ""), {
			check: async () => ({ allowed: false, reason: "user said no" }),
		});
		registry.register(tool("write", async () => ({ content: "should not run" }), false), "core");
		const h = harness(registry);

		await runToolCalls([call("1", "write")], h.deps);

		assert.equal(h.written[0]?.isError, true);
		assert.equal(h.ends[0]?.executed, false);
		assert.match(h.written[0]?.content ?? "", /^Not executed: /);
	});

	it("摘要取结果首行，长的截断", async () => {
		const long = "x".repeat(300);
		const h = harness(registryOf(tool("read", async () => ({ content: `${long}\nsecond` }))));

		await runToolCalls([call("1", "read")], h.deps);

		const summary = h.ends[0]?.summary ?? "";
		assert.equal(summary.startsWith("x".repeat(200)), true);
		assert.equal(summary.endsWith("…"), true);
		assert.equal(summary.includes("second"), false);
	});

	it("阶段性输出交给 onUpdate，不写进对话", async () => {
		const updates: string[] = [];
		const progress = tool("bash", async (args) => {
			void args;
			return { content: "done" };
		});
		const h = harness(registryOf(progress), {
			onUpdate: (_call, text) => {
				updates.push(text);
			},
		});

		await runToolCalls([call("1", "bash")], h.deps);

		// 这个工具本身不推 update，因此只验证它不会被当成结果写回
		assert.deepEqual(updates, []);
		assert.equal(h.written[0]?.content, "done");
	});

	it("被截断的工具调用全部标成失败且不执行", async () => {
		let executed = 0;
		const anyTool = tool("edit", async () => {
			executed += 1;
			return { content: "changed" };
		});
		const h = harness(registryOf(anyTool));

		await rejectToolCalls([call("1", "edit"), call("2", "edit")], h.deps);

		assert.equal(executed, 0);
		assert.deepEqual(h.starts, ["1", "2"]);
		assert.deepEqual(
			h.written.map((item) => item.content),
			[TRUNCATED_TOOL_ARGUMENTS, TRUNCATED_TOOL_ARGUMENTS],
		);
		assert.equal(h.written.every((item) => item.isError), true);
		assert.equal(h.ends.every((item) => item.executed === false), true);
	});

	it("空调用列表什么也不做", async () => {
		const h = harness(registryOf());
		await runToolCalls([], h.deps);
		await rejectToolCalls([], h.deps);
		assert.deepEqual(h.written, []);
		assert.deepEqual(h.starts, []);
	});
});
