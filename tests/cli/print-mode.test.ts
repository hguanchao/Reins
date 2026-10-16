import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

/**
 * 非交互模式的整条链路。
 *
 * 起一个说对话补全协议的本地服务，让真正的命令行进程去连它：HTTP、事件流解析、适配器、
 * 回合驱动、工具执行、会话落盘全都在这一条路径上跑一遍。用假客户端测不出这些环节之间的
 * 接缝，而接缝恰恰是最容易出问题的地方。
 */

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(PROJECT_ROOT, "src", "cli", "index.ts");

interface Recorded {
	readonly url: string;
	readonly authorization: string | undefined;
	readonly body: string;
}

/** 一个按次序应答的服务：第一次要求调用工具，第二次给出最终回答。 */
function startFakeEndpoint(): Promise<{ server: Server; port: number; requests: Recorded[] }> {
	const requests: Recorded[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			requests.push({
				url: request.url ?? "",
				authorization: Array.isArray(request.headers.authorization)
					? request.headers.authorization[0]
					: request.headers.authorization,
				body,
			});
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const payload of requests.length === 1 ? toolCallChunks() : answerChunks()) {
				response.write(`data: ${JSON.stringify(payload)}\n\n`);
			}
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as AddressInfo).port, requests });
		});
	});
}

function toolCallChunks(): unknown[] {
	return [
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								function: { name: "write", arguments: '{"path":"hello.txt",' },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, function: { arguments: '"content":"来自模型"}' } }],
					},
					finish_reason: null,
				},
			],
		},
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
	];
}

function answerChunks(): unknown[] {
	return [
		{ choices: [{ delta: { content: "已经写好 hello.txt" }, finish_reason: null }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
	];
}

const workDir = mkdtempSync(join(tmpdir(), "reins-e2e-work-"));
const homeDir = mkdtempSync(join(tmpdir(), "reins-e2e-home-"));
let server: Server | undefined;

after(() => {
	server?.close();
	rmSync(workDir, { recursive: true, force: true });
	rmSync(homeDir, { recursive: true, force: true });
});

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const runFile = promisify(execFile);

/**
 * 跑一次命令行。
 *
 * 必须用异步的 execFile：假的端点就跑在同一个进程里，同步等待会把事件循环堵住，
 * 于是子进程发出的请求永远等不到回应。
 */
async function run(args: readonly string[], options: { readonly workRoot: string }): Promise<RunResult> {
	try {
		const { stdout, stderr } = await runFile(process.execPath, [ENTRY, ...args], {
			cwd: options.workRoot,
			encoding: "utf8",
			env: { ...process.env, REINS_HOME: homeDir },
			timeout: 60_000,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

function writeConfig(port: number): { readonly workRoot: string } {
	const workRoot = join(workDir, String(port));
	mkdirSync(workRoot, { recursive: true });

	writeFileSync(
		join(homeDir, "config.toml"),
		['provider = "local"', 'model = "fake-model"', "max_retries = 0", ""].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(homeDir, "models.json"),
		JSON.stringify({
			providers: {
				local: {
					baseUrl: `http://127.0.0.1:${port}`,
					api: "openai-completions",
					apiKey: "test-key",
					models: [{ id: "fake-model", maxTokens: 1024 }],
				},
			},
		}),
		"utf8",
	);
	return { workRoot };
}

describe("reins 的整条链路", () => {
	it("连上端点、执行工具、给出回答并落盘会话", async () => {
		const started = await startFakeEndpoint();
		server = started.server;
		const { workRoot } = writeConfig(started.port);

		const result = await run(["把问候写进 hello.txt"], { workRoot });

		assert.equal(result.code, 0, `退出码 ${result.code}
标准输出：${JSON.stringify(result.stdout)}
标准错误：${JSON.stringify(result.stderr)}`);
		// 标准输出只有模型的回答，工具信息走标准错误
		assert.equal(result.stdout.trim(), "已经写好 hello.txt");
		assert.ok(result.stderr.includes("write"));
		assert.ok(result.stderr.includes("完成"));

		// 工具真的执行了
		assert.equal(readFileSync(join(workRoot, "hello.txt"), "utf8"), "来自模型");

		// 两次请求：先要工具，再给答案
		assert.equal(started.requests.length, 2);
		assert.equal(started.requests[0].url, "/chat/completions");
		assert.equal(started.requests[0].authorization, "Bearer test-key");
		const second = JSON.parse(started.requests[1].body) as { messages: { role: string }[] };
		assert.deepEqual(
			second.messages.map((message) => message.role),
			["system", "user", "assistant", "tool"],
		);

		// 会话落盘，且能解析
		const sessionFiles = findSessionFiles();
		assert.equal(sessionFiles.length, 1);
		const lines = readFileSync(sessionFiles[0], "utf8").trim().split("\n");
		const header = JSON.parse(lines[0]) as { type: string; version: number; cwd: string };
		assert.equal(header.type, "session");
		assert.equal(header.cwd, workRoot);
		assert.equal(lines.length, 8);
	});

	it("端点报错时以非零退出码结束，并说明原因", async () => {
		const failing = createServer((_request, response) => {
			response.writeHead(401, { "content-type": "application/json" });
			response.end('{"error":{"message":"密钥不对"}}');
		});
		await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
		const port = (failing.address() as AddressInfo).port;
		const { workRoot } = writeConfig(port);

		try {
			const result = await run(["随便做点什么"], { workRoot });
			assert.equal(result.code, 1, `标准错误：${JSON.stringify(result.stderr)}`);
			assert.ok(result.stderr.includes("401"));
			assert.ok(result.stderr.includes("密钥不对"));
		} finally {
			failing.close();
		}
	});

	it("读不懂的选项以用法错误结束", async () => {
		const result = await run(["--nope"], { workRoot: workDir });
		assert.equal(result.code, 2);
		assert.ok(result.stderr.includes("无法识别的选项"));
	});
});

function findSessionFiles(): readonly string[] {
	const root = join(homeDir, "sessions");
	const found: string[] = [];
	for (const directory of readdirSync(root)) {
		for (const name of readdirSync(join(root, directory))) {
			if (name.endsWith(".jsonl")) found.push(join(root, directory, name));
		}
	}
	return found;
}
