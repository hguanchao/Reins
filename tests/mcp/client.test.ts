import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { McpClient } from "#src/mcp/client.ts";
import type { JsonRpcMessage, McpTransport } from "#src/mcp/transport.ts";

interface Reply {
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

/** 按请求方法回一条 JSON-RPC 应答；通知不回复。 */
function fakeTransport(replies: Readonly<Record<string, Reply>>): McpTransport {
	const queue: JsonRpcMessage[] = [];
	let wake: (() => void) | undefined;
	let closed = false;

	return {
		async send(message): Promise<void> {
			if (typeof message["method"] !== "string" || message["id"] === undefined) return;
			const reply = replies[message["method"]];
			if (reply === undefined) return;
			queue.push({
				jsonrpc: "2.0",
				id: message["id"],
				...(reply.error === undefined ? { result: reply.result } : { error: reply.error }),
			});
			wake?.();
		},
		async *receive(): AsyncIterable<JsonRpcMessage> {
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
}

function client(transport: McpTransport): McpClient {
	return new McpClient({
		transport,
		clientName: "test",
		version: "0.0.0",
		controlTimeoutMs: 1000,
		callTimeoutMs: 1000,
	});
}

describe("MCP 健康检查", () => {
	it("ping 成功即视为连接可用", async () => {
		const connection = client(
			fakeTransport({
				initialize: { result: {} },
				ping: { result: {} },
			}),
		);
		await connection.connect();
		await connection.ping();
		connection.close();
	});

	it("server 不实现 ping 时退回列工具", async () => {
		const connection = client(
			fakeTransport({
				initialize: { result: {} },
				ping: { error: { code: -32601, message: "method not found" } },
				"tools/list": { result: { tools: [] } },
			}),
		);
		await connection.connect();
		await connection.ping();
		connection.close();
	});

	it("ping 与列工具都失败时明确报错", async () => {
		const connection = client(
			fakeTransport({
				initialize: { result: {} },
				ping: { error: { code: -32603, message: "ping failed" } },
				"tools/list": { error: { code: -32603, message: "list failed" } },
			}),
		);
		await connection.connect();
		await assert.rejects(() => connection.ping(), /list failed/);
		connection.close();
	});
});

describe("服务端通知", () => {
	it("通知按方法名交给监听者，请求照常配对", async () => {
		const queue: JsonRpcMessage[] = [];
		let wake: (() => void) | undefined;
		let closed = false;
		const transport: McpTransport = {
			async send(message): Promise<void> {
				const id = message["id"];
				if (typeof message["method"] !== "string" || id === undefined) return;
				if (message["method"] === "initialize") {
					queue.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18" } });
					wake?.();
				}
			},
			async *receive(): AsyncIterable<JsonRpcMessage> {
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
		const notifications: string[] = [];
		const client = new McpClient({
			transport,
			clientName: "test",
			version: "0.0.0",
			controlTimeoutMs: 1000,
			callTimeoutMs: 1000,
			onNotification: (method) => notifications.push(method),
		});

		await client.connect();
		queue.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		queue.push({ jsonrpc: "2.0", method: "notifications/other" });
		wake?.();
		for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(notifications, ["notifications/tools/list_changed", "notifications/other"]);
		client.close();
	});
});
