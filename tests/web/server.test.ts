import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createWebServer, type RunningWebServer, type WebServerDeps, type WebServerOptions } from "#src/web/server.ts";

/**
 * 传输层的契约:回环安全(令牌/Host/Origin)、命令转交、事件流与静态托管。
 * 装配层用假实现顶替,这里只关心 HTTP 行为本身。
 */

const TOKEN = "test-token-0123456789";

interface FakeState {
	running: boolean;
	approval: { readonly id: number; readonly request: unknown } | undefined;
	submitted: string[];
	aborted: boolean;
	resolved: Array<{ id: number; answer: string }>;
	entries: readonly unknown[];
	listeners: Set<(event: unknown) => void>;
	emit(event: unknown): void;
}

function fakeDeps(staticRoot: string | undefined): { deps: WebServerDeps; state: FakeState } {
	const state: FakeState = {
		running: false,
		approval: undefined,
		submitted: [],
		aborted: false,
		resolved: [],
		entries: [{ type: "message" }],
		listeners: new Set(),
		emit(event) {
			for (const listener of state.listeners) listener(event);
		},
	};
	const deps: WebServerDeps = {
		snapshot: () => ({ running: state.running, approval: state.approval }),
		session: () => ({ id: "s1", cwd: "/work", entries: state.entries }),
		submit: (text) => {
			if (state.running) return false;
			state.submitted.push(text);
			return true;
		},
		abort: () => {
			state.aborted = true;
		},
		approval: {
			resolve: (id, answer) => {
				state.resolved.push({ id, answer });
			},
		},
		subscribe: (listener) => {
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		staticRoot,
	};
	return { deps, state };
}

/** 用原始 http.request 发请求:fetch 不允许改写 Host 头,而 Host 校验恰恰要测它。 */
function rawRequest(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number | undefined; body: string }> {
	return new Promise((resolveRequest, rejectRequest) => {
		const request = http.request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk) => chunks.push(chunk as Buffer));
			response.on("end", () =>
				resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
			);
		});
		request.on("error", rejectRequest);
		request.end();
	});
}

async function startServer(deps: WebServerDeps, options: Partial<WebServerOptions> = {}): Promise<RunningWebServer> {
	const running = await createWebServer(deps, { token: TOKEN, port: 0, ...options }).start();
	servers.push(running);
	return running;
}

/** 测试结束统一关服务;SSE 连接先在用例里掐断,否则 close 会一直等。 */
const servers: RunningWebServer[] = [];
after(async () => {
	for (const server of servers.splice(0)) await server.close();
});

/** 从 SSE 流里读到含指定片段为止;读不到按超时失败,避免用例挂死。 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + 5000;
	for (;;) {
		if (text.includes(needle)) return text;
		if (Date.now() > deadline) throw new Error(`timeout waiting for: ${needle}`);
		const chunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				const timer = setTimeout(() => reject(new Error("read timeout")), 2000);
				timer.unref();
			}),
		]);
		if (chunk.done) throw new Error("stream ended early");
		text += decoder.decode(chunk.value, { stream: true });
	}
}

describe("web 传输层", () => {
	it("令牌缺失或错误一律 401,正确令牌放行", async () => {
		const { deps } = fakeDeps(undefined);
		const server = await startServer(deps);
		const base = `http://127.0.0.1:${server.port}`;

		const missing = await fetch(`${base}/api/state`);
		assert.equal(missing.status, 401);
		const wrong = await fetch(`${base}/api/state`, { headers: { "x-reins-token": "nope" } });
		assert.equal(wrong.status, 401);

		const byHeader = await fetch(`${base}/api/state`, { headers: { "x-reins-token": TOKEN } });
		assert.equal(byHeader.status, 200);
		// JSON 序列化会丢掉 undefined 字段,这里按线上形态断言
		assert.deepEqual(await byHeader.json(), { running: false });

		const byQuery = await fetch(`${base}/api/state?token=${TOKEN}`);
		assert.equal(byQuery.status, 200);
	});

	it("Host 不是回环主机名一律 403", async () => {
		const { deps } = fakeDeps(undefined);
		const server = await startServer(deps);
		const response = await rawRequest(server.port, "GET", `/api/state?token=${TOKEN}`, { host: "evil.example" });
		assert.equal(response.status, 403);
	});

	it("带非回环 Origin 的写请求 403", async () => {
		const { deps } = fakeDeps(undefined);
		const server = await startServer(deps);
		const response = await rawRequest(server.port, "POST", "/api/message", {
			host: "127.0.0.1",
			origin: "https://evil.example",
			"x-reins-token": TOKEN,
		});
		assert.equal(response.status, 403);
	});

	it("提交一句话转交装配层;进行中回 409;空正文回 400", async () => {
		const { deps, state } = fakeDeps(undefined);
		const server = await startServer(deps);
		const base = `http://127.0.0.1:${server.port}`;

		const empty = await fetch(`${base}/api/message`, {
			method: "POST",
			headers: { "x-reins-token": TOKEN, "content-type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});
		assert.equal(empty.status, 400);

		const ok = await fetch(`${base}/api/message`, {
			method: "POST",
			headers: { "x-reins-token": TOKEN, "content-type": "application/json" },
			body: JSON.stringify({ text: "修一下这个 bug" }),
		});
		assert.equal(ok.status, 202);
		assert.deepEqual(state.submitted, ["修一下这个 bug"]);

		state.running = true;
		const busy = await fetch(`${base}/api/message`, {
			method: "POST",
			headers: { "x-reins-token": TOKEN, "content-type": "application/json" },
			body: JSON.stringify({ text: "再来一句" }),
		});
		assert.equal(busy.status, 409);
	});

	it("中断与审批结论原样转交", async () => {
		const { deps, state } = fakeDeps(undefined);
		const server = await startServer(deps);
		const base = `http://127.0.0.1:${server.port}`;

		await fetch(`${base}/api/abort`, { method: "POST", headers: { "x-reins-token": TOKEN } });
		assert.equal(state.aborted, true);

		await fetch(`${base}/api/approval`, {
			method: "POST",
			headers: { "x-reins-token": TOKEN, "content-type": "application/json" },
			body: JSON.stringify({ id: 3, answer: "once" }),
		});
		assert.deepEqual(state.resolved, [{ id: 3, answer: "once" }]);
	});

	it("会话全量原样返回", async () => {
		const { deps } = fakeDeps(undefined);
		const server = await startServer(deps);
		const response = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
			headers: { "x-reins-token": TOKEN },
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { id: "s1", cwd: "/work", entries: [{ type: "message" }] });
	});

	it("SSE 订阅装配层推送,并按心跳保活", async () => {
		const { deps, state } = fakeDeps(undefined);
		const server = await startServer(deps, { heartbeatMs: 30 });
		const controller = new AbortController();
		const response = await fetch(`http://127.0.0.1:${server.port}/api/events?token=${TOKEN}`, {
			signal: controller.signal,
		});
		assert.equal(response.status, 200);
		const reader = response.body!.getReader();
		await readUntil(reader, "retry: 3000");
		assert.equal(state.listeners.size, 1);

		state.emit({ type: "tool_start", callId: "c1" });
		const text = await readUntil(reader, `data: {"type":"tool_start","callId":"c1"}`);
		// 心跳帧可能已随事件一起到达,也可能在下一拍
		if (!text.includes(": ping")) await readUntil(reader, ": ping");
		controller.abort();
	});

	it("静态托管:index、类型标注、SPA 回落与路径穿越拦截", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reins-web-"));
		try {
			await writeFile(join(dir, "index.html"), "<p>home</p>");
			await writeFile(join(dir, "app.js"), "console.log(1)");
			const { deps } = fakeDeps(dir);
			const server = await startServer(deps);
			const base = `http://127.0.0.1:${server.port}`;

			const home = await fetch(base);
			assert.equal(home.status, 200);
			assert.match(home.headers.get("content-type") ?? "", /^text\/html/);
			assert.equal(await home.text(), "<p>home</p>");

			const script = await fetch(`${base}/app.js`);
			assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/);

			const fallback = await fetch(`${base}/route/unknown`);
			assert.equal(fallback.status, 200);
			assert.equal(await fallback.text(), "<p>home</p>");

			// 穿越路径不允许读根目录之外的文件:回落到 index,而不是返回目标文件
			for (const attempt of ["/..%2f..%2fpackage.json", "/%2e%2e/secret.txt", "/a/../../b.txt"]) {
				const escaped = await fetch(`${base}${attempt}`);
				assert.equal(await escaped.text(), "<p>home</p>", attempt);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("未构建时首页给出构建指引", async () => {
		const { deps } = fakeDeps(undefined);
		const server = await startServer(deps);
		const response = await fetch(`http://127.0.0.1:${server.port}/`);
		assert.equal(response.status, 503);
		assert.match(await response.text(), /build:ui/);
	});
});
