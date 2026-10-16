import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { sessionsDir } from "../../src/config/paths.ts";
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
function startFakeEndpoint(options: { readonly firstTurnInputTokens?: number } = {}): Promise<{
	server: Server;
	port: number;
	requests: Recorded[];
}> {
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
			const chunks =
				requests.length === 1 ? toolCallChunks(options.firstTurnInputTokens) : answerChunks();
			for (const payload of chunks) {
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

function toolCallChunks(inputTokens?: number): unknown[] {
	const chunks: unknown[] = [
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
	// 需要触发压缩的用例就让这一轮报一个接近上限的用量
	if (inputTokens !== undefined) {
		chunks.push({
			choices: [],
			usage: { prompt_tokens: inputTokens, completion_tokens: 5, total_tokens: inputTokens + 5 },
		});
	}
	return chunks;
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
// 测试进程与子进程必须看同一个配置目录：会话目录是从它推出来的，接续才找得到刚造的那些会话
process.env["REINS_HOME"] = homeDir;
/** 所有起过的服务都记下来，结束时统一关掉：漏一个就会让测试进程一直挂着 */
const servers: Server[] = [];

after(() => {
	for (const server of servers) server.close();
	rmSync(workDir, { recursive: true, force: true });
	rmSync(homeDir, { recursive: true, force: true });
});

/** 起一个服务并登记，保证之后一定会被关掉。 */
async function serve(
	options: { readonly firstTurnInputTokens?: number } = {},
): Promise<Awaited<ReturnType<typeof startFakeEndpoint>>> {
	const started = await startFakeEndpoint(options);
	servers.push(started.server);
	return started;
}

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

function writeConfig(port: number, extra: readonly string[] = []): { readonly workRoot: string } {
	const workRoot = join(workDir, String(port));
	mkdirSync(workRoot, { recursive: true });

	writeFileSync(
		join(homeDir, "config.toml"),
		['provider = "local"', 'model = "fake-model"', "max_retries = 0", ...extra, ""].join("\n"),
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
		const started = await serve();
		const { workRoot } = writeConfig(started.port);

		// 默认审批方式是 ask，非交互模式下没人可问，因此这里显式同意
		const result = await run(["--yes", "把问候写进 hello.txt"], { workRoot });

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

		// 会话落盘，且能解析：头 + 8 条条目（含一条只用于统计的用量记录）
		const sessionFiles = findSessionFiles();
		assert.equal(sessionFiles.length, 1);
		const lines = readFileSync(sessionFiles[0], "utf8").trim().split("\n");
		const header = JSON.parse(lines[0]) as { type: string; version: number; cwd: string };
		assert.equal(header.type, "session");
		assert.equal(header.cwd, workRoot);
		assert.equal(lines.length, 9);
	});

	it("没有声明上下文上限时明确说明本次不会自动压缩", async () => {
		const started = await serve();
		const { workRoot } = writeConfig(started.port);

		const result = await run(["--yes", "把问候写进 hello.txt"], { workRoot });

		assert.equal(result.code, 0, `标准错误：${result.stderr}`);
		assert.ok(result.stderr.includes("不会自动压缩上下文"), `标准错误：${result.stderr}`);
	});

	it("上下文接近上限时先压缩再继续，压缩过程写在标准错误里", async () => {
		const started = await serve({ firstTurnInputTokens: 900 });
		const { workRoot } = writeConfig(started.port, [
			"context_window = 120",
			'compact_model = "fake-model"',
		]);

		const result = await run(["--yes", "把问候写进 hello.txt"], { workRoot });

		assert.equal(result.code, 0, `标准错误：${result.stderr}`);
		assert.ok(result.stderr.includes("压缩上下文"), `标准错误：${result.stderr}`);
		assert.ok(result.stderr.includes("完成：约"), `标准错误：${result.stderr}`);

		// 三次请求：工具那一轮、摘要、压缩后的正式请求；最后一次的上下文以摘要开头
		assert.equal(started.requests.length, 3);
		const third = JSON.parse(started.requests[2].body) as { messages: { role: string; content: string }[] };
		// 第一条是系统提示词，随后就是摘要
		assert.equal(third.messages[0].role, "system");
		assert.equal(third.messages[1].role, "user");
		assert.match(third.messages[1].content, /摘要/);

		// 被摘要掉的原始消息仍在会话文件里，用量也留着
		const lines = readFileSync(findSessionFiles(workRoot)[0], "utf8").trim().split("\n");
		const entries = lines.slice(1).map((line) => JSON.parse(line) as { type: string });
		assert.ok(entries.some((entry) => entry.type === "compaction"));
		assert.ok(entries.some((entry) => entry.type === "message"));
	});

	it("--resume 接着原来的会话继续，历史进了下一次请求", async () => {
		const started = await serve();
		const { workRoot } = writeConfig(started.port);

		// 先造一个有历史的会话：文件就放在这个工作根对应的会话目录里
		const file = join(sessionsDir(workRoot), "past1234.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: "past1234", timestamp: "2026-10-16T00:00:00.000Z", cwd: workRoot }),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-10-16T00:00:01.000Z",
				message: { role: "user", content: "先读一下 hello.txt" },
			}),
			JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-10-16T00:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "读完了" }] },
			}),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

		const result = await run(["--resume", "past1234", "--yes", "接着改一下"], { workRoot });

		assert.equal(result.code, 0, `标准错误：${result.stderr}`);
		// 第二次请求里带着上一次的上下文：使用者说了什么、助手答了什么都在
		const request = JSON.parse(started.requests[0].body) as { messages: { role: string; content: string }[] };
		const text = JSON.stringify(request.messages);
		assert.ok(text.includes("先读一下 hello.txt"), text);
		assert.ok(text.includes("读完了"), text);

		// 写回的是同一个文件，旧条目在前面
		const written = readFileSync(file, "utf8").trim().split("\n");
		assert.equal(JSON.parse(written[0]).id, "past1234");
		assert.ok(written.length > lines.length);
		assert.ok(written[1].includes("先读一下 hello.txt"));
	});

	it("没有 --yes 时改动类操作被拒，且说明怎么办", async () => {
		const started = await serve();
		const { workRoot } = writeConfig(started.port);

		const result = await run(["把问候写进 hello.txt"], { workRoot });

		// 这一轮本身是正常结束的：模型收到了「没执行」的结果并据此作答，只是工具确实没跑
		assert.equal(result.code, 0, `标准错误：${result.stderr}`);
		assert.ok(result.stderr.includes("未执行"), `标准错误：${result.stderr}`);
		assert.ok(result.stderr.includes("--yes"));
		// 关键的一条：工具没有真的执行
		assert.ok(!existsSync(join(workRoot, "hello.txt")));
	});

	it("端点报错时以非零退出码结束，并说明原因", async () => {
		const failing = createServer((_request, response) => {
			response.writeHead(401, { "content-type": "application/json" });
			response.end('{"error":{"message":"密钥不对"}}');
		});
		await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
		const port = (failing.address() as AddressInfo).port;
		const { workRoot } = writeConfig(port);

		servers.push(failing);
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

/** 找出这次运行留下的会话文件。多个用例共用一个配置目录，因此按工作根挑出自己的那些。 */
function findSessionFiles(workRoot?: string): readonly string[] {
	const root = join(homeDir, "sessions");
	const found: string[] = [];
	for (const directory of readdirSync(root)) {
		for (const name of readdirSync(join(root, directory))) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(root, directory, name);
			if (workRoot !== undefined && sessionCwdOf(file) !== workRoot) continue;
			found.push(file);
		}
	}
	return found;
}

/** 会话文件首行里的工作根。 */
function sessionCwdOf(file: string): string | undefined {
	const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0] ?? "") as { cwd?: string };
	return header.cwd;
}
