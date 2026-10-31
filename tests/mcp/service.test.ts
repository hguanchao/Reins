import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import {
	RECONNECT_DELAYS_MS,
	STARTUP_SETTLE_MS,
	startMcpServers,
	type McpControl,
	type McpStatusSource,
} from "#src/mcp/service.ts";
import type { McpServerConfig } from "#src/config/file.ts";
import type { JsonRpcMessage, McpTransport } from "#src/mcp/transport.ts";

/**
 * 传输层按脚本走：每个连接尝试消耗一个脚本，脚本决定握手是否成功、请求回什么。
 * 测试经 push() 在连接建立后注入服务端通知。
 *
 * mock timers 只有同步 tick，而回音靠微任务接力，所以时间推进用「小步 tick +
 * setImmediate 冲刷」的组合：每步之间把挂着的微任务跑完，级联的定时器才接得上。
 */

interface Script {
	replies: Record<string, unknown>;
	failPump?: boolean;
}

const SERVER: McpServerConfig = {
	name: "srv",
	type: "stdio",
	command: "noop",
	args: [],
	url: undefined,
	headers: {},
	env: {},
	timeoutSeconds: undefined,
	disabled: false,
};

const TOOL = (name: string) => ({ name, description: "", inputSchema: { type: "object", properties: {} } });
const OK_REPLIES = (names: readonly string[]): Record<string, unknown> => ({
	initialize: { protocolVersion: "2025-06-18" },
	"tools/list": { tools: names.map(TOOL) },
});

function makeTransports(scripts: Script[]) {
	const controllers: { push: (message: JsonRpcMessage) => void }[] = [];
	const factory = (): { readonly transport: McpTransport } => {
		const script = scripts.shift() ?? { replies: {}, failPump: true };
		const queue: JsonRpcMessage[] = [];
		let wake: (() => void) | undefined;
		let closed = false;
		controllers.push({
			push: (message) => {
				queue.push(message);
				wake?.();
			},
		});
		const transport: McpTransport = {
			async send(message): Promise<void> {
				const id = message["id"];
				if (typeof message["method"] !== "string" || id === undefined) return;
				const result = script.replies[message["method"]];
				if (result === undefined) return;
				queue.push({ jsonrpc: "2.0", id, result });
				wake?.();
			},
			async *receive(): AsyncIterable<JsonRpcMessage> {
				if (script.failPump === true) throw new Error("spawn failed");
				for (;;) {
					const next = queue.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					if (closed) return;
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			},
			close(): void {
				closed = true;
				wake?.();
			},
		};
		return { transport };
	};
	return { factory, controllers };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 6; index += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function advance(t: TestContext, ms: number): Promise<void> {
	let advanced = 0;
	while (advanced < ms) {
		const step = Math.min(100, ms - advanced);
		t.mock.timers.tick(step);
		advanced += step;
		await flush();
	}
}

interface Harness {
	control: McpControl;
	status: McpStatusSource;
	registered: string[];
	unregistered: string[];
	controllers: { push: (message: JsonRpcMessage) => void }[];
}

function start(scripts: Script[]): Harness {
	const harness: Harness = {
		control: undefined as never,
		status: undefined as never,
		registered: [],
		unregistered: [],
		controllers: [],
	};
	const { factory, controllers } = makeTransports(scripts);
	harness.controllers = controllers;
	startMcpServers({
		cwd: ".",
		version: "0.0.0",
		servers: [SERVER],
		registerTool: (tool) => harness.registered.push(tool.name),
		unregisterTool: (name) => harness.unregistered.push(name),
		onStatus: (source) => {
			harness.status = source;
		},
		onControl: (control) => {
			harness.control = control;
		},
		transportFactory: factory,
	});
	return harness;
}

describe("MCP 启动收口", () => {
	it("全部连上时立即放行，不用等满窗口", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const started = Date.now();
		const harness = start([{ replies: OK_REPLIES(["a", "b"]) }]);
		await flush();

		const pending = harness.control.awaitStartup();
		await advance(t, 200);
		await pending;
		// 门放行后时钟只走了这几步,远不到收口窗口
		assert.ok(Date.now() - started < STARTUP_SETTLE_MS);
	});

	it("有 server 一直连不上时等到窗口结束，且整个进程只等一次", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const started = Date.now();
		// 有响应通道但不含 initialize 应答：握手挂起，状态停在 connecting
		const harness = start([{ replies: {} }]);
		await flush();

		const pending = harness.control.awaitStartup();
		await advance(t, STARTUP_SETTLE_MS + 200);
		await pending;
		assert.ok(Date.now() - started >= STARTUP_SETTLE_MS);

		// 第二次调用直接放行：一个连不上的 server 不能让每次提交都白等
		await harness.control.awaitStartup();
	});
});

describe("MCP 断线自动重连", () => {
	it("启动失败后退避重连，成功后注册工具并复位计数", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const harness = start([{ replies: {}, failPump: true }, { replies: OK_REPLIES(["a", "b"]) }]);
		await flush();

		assert.equal(harness.status()[0].status, "unreachable");
		assert.ok(harness.status()[0].detail.includes("retrying: attempt 1/5"));

		await advance(t, RECONNECT_DELAYS_MS[0] + 100);
		await flush();
		assert.equal(harness.status()[0].status, "connected");
		assert.deepEqual([...harness.registered].sort(), ["srv_a", "srv_b"]);
	});

	it("退避耗尽后停在 failed，等使用者在 /mcps 里手动重连", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const harness = start([{ replies: {}, failPump: true }]);
		await flush();

		// 每次尝试要么败在退避点、要么败在 15s 的握手超时，只要时间足够长总会耗尽
		for (let index = 0; index < 20; index += 1) {
			await advance(t, 20_000);
			await flush();
			if (harness.status()[0].detail.includes("retries exhausted")) break;
		}
		assert.equal(harness.status()[0].status, "unreachable");
		assert.ok(harness.status()[0].detail.includes("retries exhausted"));
	});
});

describe("tools/list_changed 增量刷新", () => {
	it("新增的工具登记，下线的工具摘除", async () => {
		const script: Script = { replies: OK_REPLIES(["a", "b"]) };
		const harness = start([script]);
		await flush();
		assert.deepEqual([...harness.registered].sort(), ["srv_a", "srv_b"]);

		// 服务端改了清单：b 下线，c 上线，然后推送变更通知
		script.replies["tools/list"] = OK_REPLIES(["a", "c"])["tools/list"];
		harness.controllers[0]?.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await flush();

		assert.deepEqual(harness.unregistered, ["srv_b"]);
		assert.ok(harness.registered.includes("srv_c"));
		// 清单口径同步更新，/mcps 的统计跟着变
		assert.ok(harness.status()[0].detail.includes("a, c"));
	});
});
