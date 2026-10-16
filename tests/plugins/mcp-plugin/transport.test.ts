import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
	createHttpTransport,
	createSseTransport,
	createStdioTransport,
	type JsonRpcMessage,
	type McpTransport,
} from "../../../src/plugins/mcp-plugin/transport.ts";

/**
 * 三种传输。
 *
 * 本地进程用真的起一个子进程来验：管道、按行切分、以及「服务端往标准输出打了非协议内容」
 * 这几件事只有真进程才测得出。远程两种用本地 HTTP 服务端来验，响应形态由用例决定。
 */

const fixture = fileURLToPath(new URL("./fixture-server.mjs", import.meta.url));
const servers: Server[] = [];

after(() => {
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
});

function iteratorOf(transport: McpTransport): AsyncIterator<JsonRpcMessage> {
	return transport.receive()[Symbol.asyncIterator]();
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server): Promise<string> {
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve(`http://127.0.0.1:${port}/mcp`);
		});
	});
}

/** 旧式 SSE 要先拿到投递地址才发得出去，这里等到发得出去为止。 */
async function sendWhenReady(transport: McpTransport, message: JsonRpcMessage): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await transport.send(message);
			return;
		} catch (error) {
			if (attempt >= 200) throw error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

describe("stdio 传输", () => {
	it("按行收发，并且跳过服务端夹在中间的非协议输出", async () => {
		const closes: string[] = [];
		const transport = createStdioTransport({
			command: process.execPath,
			args: [fixture],
			cwd: process.cwd(),
			onClose: (reason) => closes.push(reason),
		});
		const messages = iteratorOf(transport);

		try {
			await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
			const first = await messages.next();
			// 夹具在回音之前先写了一行不是 JSON 的东西；能拿到回音就说明它被跳过了
			assert.equal(first.value?.["id"], 1);

			await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
			const second = await messages.next();
			assert.equal(second.value?.["id"], 2);
			assert.deepEqual(closes, []);
		} finally {
			transport.close();
		}
	});

	it("进程起不来时把原因报出来", async () => {
		const closes: string[] = [];
		const transport = createStdioTransport({
			command: "reins-不存在的命令",
			args: [],
			cwd: process.cwd(),
			onClose: (reason) => closes.push(reason),
		});
		const messages = iteratorOf(transport);

		try {
			await messages.next();
			assert.equal(closes.length, 1);
			assert.match(closes[0], /无法启动/);
		} finally {
			transport.close();
		}
	});
});

describe("http 传输", () => {
	it("POST 一发一收", async () => {
		const server = createServer((request, response) => {
			void readBody(request).then((body) => {
				const message = JSON.parse(body) as JsonRpcMessage;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: message["id"], result: { ok: true } }));
			});
		});
		const url = await listen(server);
		const transport = createHttpTransport({
			url,
			headers: {},
			signal: new AbortController().signal,
			onClose: () => undefined,
		});

		const messages = iteratorOf(transport);
		await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
		const message = await messages.next();

		assert.deepEqual(message.value?.["result"], { ok: true });
		transport.close();
	});

	it("通知没有响应体，不当成错误", async () => {
		const server = createServer((request, response) => {
			void readBody(request).then(() => {
				response.writeHead(202);
				response.end();
			});
		});
		const url = await listen(server);
		const transport = createHttpTransport({
			url,
			headers: {},
			signal: new AbortController().signal,
			onClose: () => undefined,
		});

		await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		transport.close();
	});

	it("非成功状态把响应体片段带出来", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(500, { "content-type": "text/plain" });
			response.end("服务端炸了");
		});
		const url = await listen(server);
		const transport = createHttpTransport({
			url,
			headers: {},
			signal: new AbortController().signal,
			onClose: () => undefined,
		});

		await assert.rejects(() => transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }), /HTTP 500 服务端炸了/);
		transport.close();
	});

	it("响应是一串事件时按条读出来", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { step: 1 } })}\n\n`);
			response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { step: 2 } })}\n\n`);
			response.end();
		});
		const url = await listen(server);
		const transport = createHttpTransport({
			url,
			headers: {},
			signal: new AbortController().signal,
			onClose: () => undefined,
		});

		const messages = iteratorOf(transport);
		await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

		assert.deepEqual((await messages.next()).value?.["result"], { step: 1 });
		assert.deepEqual((await messages.next()).value?.["result"], { step: 2 });
		transport.close();
	});
});

describe("sse 传输", () => {
	it("先收投递地址，请求发给它，响应从长连接回来", async () => {
		let stream: ServerResponse | undefined;
		const server = createServer((request, response) => {
			if (request.method === "GET") {
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				stream = response;
				response.write("event: endpoint\ndata: /messages\n\n");
				return;
			}
			void readBody(request).then((body) => {
				const message = JSON.parse(body) as JsonRpcMessage;
				stream?.write(
					`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result: { ok: true } })}\n\n`,
				);
				response.writeHead(202);
				response.end();
			});
		});
		const url = await listen(server);
		const transport = createSseTransport({
			url,
			headers: {},
			signal: new AbortController().signal,
			onClose: () => undefined,
		});

		const messages = iteratorOf(transport);
		await sendWhenReady(transport, { jsonrpc: "2.0", id: 7, method: "ping" });
		const message = await messages.next();

		assert.equal(message.value?.["id"], 7);
		assert.deepEqual(message.value?.["result"], { ok: true });
		transport.close();
	});

	it("长连接断开时告知原因", async () => {
		const closes: string[] = [];
		const server = createServer((request, response) => {
			if (request.method !== "GET") return;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end();
		});
		const url = await listen(server);
		const transport = createSseTransport({
			url,
			headers: {},
			signal: new AbortController().signal,
			onClose: (reason) => closes.push(reason),
		});
		const messages = iteratorOf(transport);

		await messages.next();
		await tick();
		assert.deepEqual(closes, ["服务端关闭了事件流"]);
		transport.close();
	});
});
