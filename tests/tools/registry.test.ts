import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolRegistry, type GateRequest, type ToolGate, type ToolRunContext } from "../../src/tools/registry.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import type { JsonSchema } from "../../src/tools/schema.ts";
import type { ToolDefinition, ToolResult } from "../../src/tools/contract.ts";
import type { WorkspaceBoundary } from "../../src/workspace/boundary.ts";
import type { SandboxView } from "../../src/sandbox/policy.ts";

const ECHO_SCHEMA: JsonSchema = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"],
};

function toolWith(schema: JsonSchema, execute: (args: Record<string, unknown>) => Promise<ToolResult>): ToolDefinition {
	return {
		name: "echo-tool",
		description: "echoes text",
		parameters: schema,
		annotations: { readOnly: true, destructive: false, openWorld: false },
		execute: (context) => execute(context.args),
	};
}

const ECHO = toolWith(ECHO_SCHEMA, async (args) => ({ content: `echo:${args["text"]}` }));

const ALLOW: ToolGate = {
	check: async (_request: GateRequest) => ({ allowed: true, reason: "" }),
};

const deny = (reason: string): ToolGate => ({
	check: async () => ({ allowed: false, reason }),
});

const explodeGate: ToolGate = {
	check: async () => {
		throw new Error("gate is down");
	},
};

function noSpill(): ResultSpiller {
	return new ResultSpiller(0, "");
}

function context(): ToolRunContext {
	return {
		workspace: { root: "E:\\w" } as WorkspaceBoundary,
		sandbox: {} as SandboxView,
		session: {} as never,
		signal: new AbortController().signal,
		onUpdate: () => undefined,
	};
}

function registryWith(gate: ToolGate, spiller: ResultSpiller = noSpill()): ToolRegistry {
	const registry = new ToolRegistry(spiller, gate);
	registry.register(ECHO, "core");
	return registry;
}

describe("工具注册表", () => {
	it("注册、查询与列出", () => {
		const registry = registryWith(ALLOW);
		assert.equal(registry.get("echo-tool")?.name, "echo-tool");
		assert.equal(registry.get("missing"), undefined);
		assert.deepEqual(registry.list().map((tool) => tool.name), ["echo-tool"]);
		assert.deepEqual(registry.describe(), [{ name: "echo-tool", source: "core" }]);
	});

	it("插件不能取代核心工具，名字重复也不行", () => {
		const registry = registryWith(ALLOW);
		assert.throws(() => registry.register(ECHO, "plugin"), /cannot be replaced by a plugin/);
		assert.throws(() => registry.register(ECHO, "core"), /already registered/);
	});

	it("随包插件工具的来源单独标记", () => {
		const registry = new ToolRegistry(noSpill(), ALLOW);
		registry.register(ECHO, "bundled");
		assert.deepEqual(registry.describe(), [{ name: "echo-tool", source: "bundled" }]);
	});

	it("附加工具:复制出新注册表，原名占用报错", () => {
		const registry = registryWith(ALLOW);
		const extra = toolWith(ECHO_SCHEMA, async () => ({ content: "x" }));
		const extra2: ToolDefinition = { ...extra, name: "echo-2", execute: extra.execute };
		const none: ToolDefinition = { ...extra, name: "echo-tool" };
		assert.throws(() => registry.withExtraTool(none), /already in use/);
		const copy = registry.withExtraTool(extra2);
		assert.equal(copy.get("echo-2")?.name, "echo-2");
		assert.equal(copy.get("echo-tool")?.name, "echo-tool");
		assert.equal(registry.get("echo-2"), undefined); // 原注册表不受影响
	});

	it("排除工具:复制出新注册表，原表不受影响", () => {
		const registry = registryWith(ALLOW);
		const extra: ToolDefinition = { ...ECHO, name: "echo-2" };
		const withExtra = registry.withExtraTool(extra);
		const reduced = withExtra.without("echo-tool");

		assert.deepEqual(reduced.list().map((tool) => tool.name), ["echo-2"]);
		assert.equal(reduced.get("echo-tool"), undefined);
		assert.equal(withExtra.get("echo-tool")?.name, "echo-tool");
		assert.throws(() => registry.without("missing"), /unknown tool/);
	});

	it("未知工具给出可用清单", async () => {
		const outcome = await registryWith(ALLOW).call({ callId: "c", name: "nope", args: {} }, context());
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /Unknown tool: nope\. Available tools: echo-tool/);
	});

	it("审批请求带上工具来源与可记住范围", async () => {
		let source: string | undefined;
		let scope: unknown;
		const gate: ToolGate = {
			check: async (request: GateRequest) => {
				source = request.source;
				scope = request.scope;
				return { allowed: true, reason: "" };
			},
		};
		const registry = new ToolRegistry(noSpill(), gate);
		registry.register(ECHO, "plugin");

		await registry.call({ callId: "c", name: "echo-tool", args: { text: "x" } }, context());

		assert.equal(source, "plugin");
		assert.deepEqual(scope, { key: "echo-tool", label: "echo-tool", short: "echo-tool" });
	});

	it("参数错误回显收到的参数", async () => {
		const outcome = await registryWith(ALLOW).call({ callId: "c", name: "echo-tool", args: { text: 1 } }, context());
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /Invalid arguments:[\s\S]*Received arguments: {"text":1}/);
	});

	it("成功执行,结果不溢出时原样返回", async () => {
		const outcome = await registryWith(ALLOW).call({ callId: "c", name: "echo-tool", args: { text: "hi" } }, context());
		assert.deepEqual({ content: outcome.content, isError: outcome.isError }, { content: "echo:hi", isError: false });
		assert.ok(outcome.durationMs >= 0);
	});

	it("审批拒绝时工具不执行", async () => {
		const executed = [];
		const gate = deny("danger");
		const spy: ToolDefinition = {
			...ECHO,
			execute: async (callContext) => {
				executed.push(callContext.callId);
				return { content: "" };
			},
		};
		const registry = new ToolRegistry(noSpill(), gate);
		registry.register(spy, "core");
		const outcome = await registry.call({ callId: "c", name: "echo-tool", args: { text: "x" } }, context());
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /Not executed: danger/);
		assert.equal(executed.length, 0);
	});

	it("判定本身抛错按拒绝处理", async () => {
		const outcome = await registryWith(explodeGate).call({ callId: "c", name: "echo-tool", args: { text: "x" } }, context());
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /Approval check failed.*gate is down/);
	});

	it("工具抛错转成错误结果", async () => {
		const bomb = toolWith(ECHO_SCHEMA, async () => {
			throw new Error("boom");
		});
		const registry = new ToolRegistry(noSpill(), ALLOW);
		registry.register(bomb, "core");
		const outcome = await registry.call({ callId: "c", name: "echo-tool", args: { text: "x" } }, context());
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /Tool execution failed: boom/);
	});

	it("插件提供的 prepareArguments 抛错转成错误结果,不中断调用", async () => {
		const broken = {
			...ECHO,
			prepareArguments: (): Record<string, unknown> => {
				throw new Error("plugin blew up");
			},
		};
		const registry = new ToolRegistry(noSpill(), ALLOW);
		registry.register(broken, "plugin");
		const outcome = await registry.call({ callId: "c", name: "echo-tool", args: { text: "x" } }, context());
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /argument preparation failed: plugin blew up/);
	});

	it("permissionScope 抛错按拒绝返回错误结果", async () => {
		const broken = {
			...ECHO,
			permissionScope: (): never => {
				throw new Error("scope unavailable");
			},
		};
		const registry = new ToolRegistry(noSpill(), ALLOW);
		registry.register(broken, "plugin");
		const outcome = await registry.call({ callId: "c", name: "echo-tool", args: { text: "x" } }, context());
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /permission scope.*scope unavailable/);
	});

	it("结果经防溢出器处理", async () => {
		const spiller = new ResultSpiller(0, "");
		// 短路掉真实的落盘行为，只看注册表有没有把结果交给它
		spiller.spill = (toolName: string, content: string) => `${toolName}!${content}`;
		const outcome = await registryWith(ALLOW, spiller).call({ callId: "c", name: "echo-tool", args: { text: "hi" } }, context());
		assert.equal(outcome.content, "echo-tool!echo:hi");
	});

	it("prepareArguments 在校验前整理参数", async () => {
		const preparing = toolWith(ECHO_SCHEMA, async (args) => ({ content: `echo:${args["text"]}` }));
		// 常见的畸形写法：模型把参数塞进 payload 键里；整理层把它摊回顶层
		const wrapped: ToolDefinition = {
			...preparing,
			prepareArguments: (args) => {
				const payload = args["payload"];
				return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : args;
			},
		};
		const registry = new ToolRegistry(noSpill(), ALLOW);
		registry.register(wrapped, "core");
		const outcome = await registry.call(
			{ callId: "c", name: "echo-tool", args: { payload: { text: "hi" } } as Record<string, unknown> },
			context(),
		);
		assert.equal(outcome.content, "echo:hi");
	});

	it("校验后的参数才进 gate 与工具", async () => {
		let passed: unknown;
		const gate: ToolGate = {
			check: async (request: GateRequest) => {
				passed = request.args;
				return { allowed: true, reason: "" };
			},
		};
		const registry = new ToolRegistry(noSpill(), gate);
		registry.register(ECHO, "core");
		await registry.call({ callId: "c", name: "echo-tool", args: { text: "hi", extra: 1 } }, context());
		assert.equal(passed, undefined); // 多余键校验就该拦下
	});

	it("把工具的结构化结果原样交给调用方", async () => {
		const details = { matched: 3 };
		const registry = new ToolRegistry(noSpill(), ALLOW);
		registry.register(
			toolWith(ECHO_SCHEMA, async () => ({ content: "ok", details })),
			"core",
		);

		const outcome = await registry.call({ callId: "c", name: "echo-tool", args: { text: "hi" } }, context());

		assert.deepEqual(outcome.details, details);
	});
});
