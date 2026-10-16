import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { McpClient } from "../../../src/plugins/mcp-plugin/client.ts";
import type { JsonRpcMessage, McpTransport } from "../../../src/plugins/mcp-plugin/transport.ts";

/**
 * MCP 客户端的报文配对。
 *
 * 用内存里的一条队列代替真实连接：回音什么时候回来、按什么顺序回来、回不回，都由用例决定，
 * 于是超时、乱序、服务端主动请求这些在真连接上很难凑出来的情形都能钉住。
 */

class FakeTransport implements McpTransport {
	readonly sent: JsonRpcMessage[] = [];
	readonly #items: JsonRpcMessage[] = [];
	readonly #waiters: ((result: IteratorResult<JsonRpcMessage>) => void)[] = [];
	readonly #onSend: ((message: JsonRpcMessage) => void) | undefined;
	closed = false;

	constructor(onSend?: (message: JsonRpcMessage) => void) {
		this.#onSend = onSend;
	}

	async send(message: JsonRpcMessage): Promise<void> {
		this.sent.push(message);
		this.#onSend?.(message);
	}

	push(message: JsonRpcMessage): void {
		const waiter = this.#waiters.shift();
		if (waiter !== undefined) {
			waiter({ value: message, done: false });
			return;
		}
		this.#items.push(message);
	}

	receive(): AsyncIterable<JsonRpcMessage> {
		return {
			[Symbol.asyncIterator]: (): AsyncIterator<JsonRpcMessage> => ({
				next: (): Promise<IteratorResult<JsonRpcMessage>> => {
					const item = this.#items.shift();
					if (item !== undefined) return Promise.resolve({ value: item, done: false });
					if (this.closed) return Promise.resolve({ value: undefined, done: true });
					return new Promise((resolve) => this.#waiters.push(resolve));
				},
			}),
		};
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
	}
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function clientWith(
	transport: FakeTransport,
	timeouts: { readonly control?: number; readonly call?: number } = {},
): McpClient {
	return new McpClient({
		transport,
		clientName: "reins",
		version: "0.0.0",
		controlTimeoutMs: timeouts.control ?? 200,
		callTimeoutMs: timeouts.call ?? 200,
	});
}

/** 走完握手，返回一个连上的客户端。 */
async function connected(transport: FakeTransport): Promise<McpClient> {
	const client = clientWith(transport);
	const connecting = client.connect();
	await tick();
	const request = transport.sent.find((message) => message["method"] === "initialize");
	transport.push({ jsonrpc: "2.0", id: request?.["id"], result: { protocolVersion: "2025-06-18" } });
	await connecting;
	return client;
}

function methodOf(message: JsonRpcMessage): unknown {
	return message["method"];
}

describe("MCP 客户端", () => {
	it("握手：先 initialize，再发 initialized 通知", async () => {
		const transport = new FakeTransport();
		const connecting = clientWith(transport).connect();
		await tick();

		const request = transport.sent.find((message) => methodOf(message) === "initialize");
		assert.ok(request !== undefined);
		assert.deepEqual(request["params"], {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "reins", version: "0.0.0" },
		});
		// 握手还没回来时不该抢跑通知
		assert.equal(transport.sent.length, 1);

		transport.push({ jsonrpc: "2.0", id: request["id"], result: { protocolVersion: "2025-06-18" } });
		await connecting;

		assert.deepEqual(transport.sent.map(methodOf), ["initialize", "notifications/initialized"]);
	});

	it("列工具：形状不对的条目跳过，参数模式原样带出来", async () => {
		const transport = new FakeTransport((message) => {
			if (methodOf(message) !== "tools/list") return;
			transport.push({
				jsonrpc: "2.0",
				id: message["id"],
				result: {
					tools: [
						{
							name: "echo",
							description: "说回来",
							inputSchema: { type: "object", properties: { text: { type: "string" } } },
						},
						{ name: 42 },
						"不是对象",
					],
				},
			});
		});

		const tools = await (await connected(transport)).listTools();

		assert.equal(tools.length, 1);
		assert.deepEqual(tools[0], {
			name: "echo",
			description: "说回来",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
		});
	});

	it("工具结果：文本块拼起来，非文本块说明它们存在", async () => {
		const transport = new FakeTransport((message) => {
			if (methodOf(message) !== "tools/call") return;
			transport.push({
				jsonrpc: "2.0",
				id: message["id"],
				result: {
					content: [
						{ type: "text", text: "回声：你好" },
						{ type: "image", data: "x", mimeType: "image/png" },
					],
				},
			});
		});

		const result = await (await connected(transport)).callTool(
			"echo",
			{ text: "你好" },
			new AbortController().signal,
		);

		assert.equal(result.isError, false);
		// 图片显示不出来，但必须说一声，否则模型会以为服务端只回了这句文字
		assert.equal(result.content, "回声：你好\n\n[image 内容，本程序不显示]");

		const call = transport.sent.find((message) => methodOf(message) === "tools/call");
		assert.deepEqual(call?.["params"], { name: "echo", arguments: { text: "你好" } });
	});

	it("服务端报错时把它的原话带出来", async () => {
		const transport = new FakeTransport((message) => {
			if (methodOf(message) !== "tools/list") return;
			transport.push({
				jsonrpc: "2.0",
				id: message["id"],
				error: { code: -32601, message: "不认识这个方法" },
			});
		});

		await assert.rejects(() => connected(transport).then((client) => client.listTools()), /不认识这个方法（-32601）/);
	});

	it("控制请求超时后报出方法名与时限", async () => {
		const transport = new FakeTransport();
		await assert.rejects(
			() => clientWith(transport, { control: 20 }).listTools(),
			/tools\/list 超过 20ms 没有响应/,
		);
	});

	it("工具调用用自己的时限，比控制请求宽松", async () => {
		const transport = new FakeTransport();
		await assert.rejects(
			() => clientWith(transport, { control: 20, call: 60 }).callTool("echo", {}, new AbortController().signal),
			/tools\/call 超过 60ms 没有响应/,
		);
	});

	it("中止时告诉服务端别再算了", async () => {
		const transport = new FakeTransport();
		const client = clientWith(transport);
		const controller = new AbortController();

		const call = client.callTool("echo", {}, controller.signal);
		controller.abort();

		await assert.rejects(() => call, /已中止/);
		const cancelled = transport.sent.find((message) => methodOf(message) === "notifications/cancelled");
		assert.ok(cancelled !== undefined);
		assert.deepEqual(cancelled["params"], { requestId: 1, reason: "已中止" });
	});

	it("服务端反过来请求本程序时明确回一句不支持，免得对方一直等", async () => {
		const transport = new FakeTransport();
		const client = await connected(transport);

		transport.push({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} });
		await tick();

		const reply = transport.sent.find((message) => message["id"] === 99);
		assert.deepEqual(reply?.["error"], { code: -32601, message: "本程序不支持这个请求" });
		assert.equal(client.close(), undefined);
	});

	it("连接断掉时叫醒还等着的请求", async () => {
		const transport = new FakeTransport();
		const client = await connected(transport);
		const call = client.listTools();
		transport.close();

		await assert.rejects(() => call, /连接已经断开/);
	});
});
