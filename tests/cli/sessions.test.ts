import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

/**
 * `reins sessions` 的两个子命令。
 *
 * 走真正的命令行：插件装载、配置读取、会话仓库都在这条路径上，而列表与详情要的正是「磁盘上
 * 到底有什么」。会话文件直接造出来，不经过模型。
 */

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(PROJECT_ROOT, "src", "cli", "index.ts");

const home = mkdtempSync(join(tmpdir(), "reins-sessions-home-"));
const workRoot = mkdtempSync(join(tmpdir(), "reins-sessions-work-"));

after(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(workRoot, { recursive: true, force: true });
});

writeFileSync(
	join(home, "config.toml"),
	['provider = "local"', 'model = "fake-model"', ""].join("\n"),
	"utf8",
);
writeFileSync(
	join(home, "models.json"),
	JSON.stringify({
		providers: { local: { baseUrl: "https://example.com", api: "openai-completions", models: [{ id: "fake-model" }] } },
	}),
	"utf8",
);

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

function run(args: readonly string[]): RunResult {
	try {
		const stdout = execFileSync(process.execPath, [ENTRY, ...args], {
			cwd: workRoot,
			encoding: "utf8",
			env: { ...process.env, REINS_HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

/** 直接在会话目录里写一个会话文件：命令只看这些文件，不关心是谁写的。 */
function writeSession(id: string, entries: readonly unknown[], forkedFrom?: { session: string; entry: string }): string {
	const directory = join(home, "sessions", workRoot.replaceAll(/[/\\:]/g, "-").replace(/^-/, ""));
	mkdirSync(directory, { recursive: true });
	const file = join(directory, `${id}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 1,
			id,
			timestamp: "2026-10-16T02:00:00.000Z",
			cwd: workRoot,
			...(forkedFrom === undefined ? {} : { forkedFrom }),
		}),
		...entries.map((entry) => JSON.stringify(entry)),
	];
	writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

function message(id: string, parentId: string | null, role: string, content: string): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-16T02:00:01.000Z",
		message: role === "user" ? { role, content } : { role, content: [{ type: "text", text: content }] },
	};
}

describe("reins sessions", () => {
	it("目录里还没有会话时说明这一点，不是错误", () => {
		const result = run(["sessions", "list"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.stdout.includes("还没有会话"), result.stdout);
	});

	it("列出会话的标识、条目数与第一句话", () => {
		writeSession("aaaa1111", [
			message("e1", null, "user", "把配置改一下"),
			message("e2", "e1", "assistant", "改好了"),
		]);
		writeSession(
			"bbbb2222",
			[message("f1", null, "user", "接着刚才的往下做")],
			{ session: "aaaa1111", entry: "e2" },
		);

		const result = run(["sessions", "list"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.stdout.includes("aaaa1111"), result.stdout);
		assert.ok(result.stdout.includes("把配置改一下"), result.stdout);
		// 分叉出来的会话要看得出来自哪里
		assert.ok(result.stdout.includes("分叉自 aaaa1111"), result.stdout);
		assert.ok(result.stdout.includes("接着刚才的往下做"), result.stdout);
	});

	it("详情列出每一条、标注类型与当前位置", () => {
		const result = run(["sessions", "show", "aaaa1111"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.stdout.includes("会话 aaaa1111"), result.stdout);
		assert.ok(result.stdout.includes("目录：" + workRoot), result.stdout);
		assert.ok(result.stdout.includes("使用者：把配置改一下"), result.stdout);
		assert.ok(result.stdout.includes("助手：改好了"), result.stdout);
		assert.ok(result.stdout.includes("当前位置：e2"), result.stdout);
	});

	it("详情里带上分叉出处", () => {
		const result = run(["sessions", "show", "bbbb2222"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.stdout.includes("分叉自：aaaa1111 的 e2"), result.stdout);
	});

	it("导出成 Markdown，含完整历史与用量", () => {
		const result = run(["sessions", "export", "aaaa1111"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.stdout.startsWith("# 会话 aaaa1111"), result.stdout);
		assert.ok(result.stdout.includes("### 使用者"));
		assert.ok(result.stdout.includes("把配置改一下"));
		assert.ok(result.stdout.includes("改好了"));
		assert.ok(result.stdout.includes("## 用量"));
	});

	it("详情与导出都带上用量汇总", () => {
		writeSession("eeee4444", [
			message("h1", null, "user", "跑一下测试"),
			{
				type: "usage",
				id: "h2",
				parentId: "h1",
				timestamp: "2026-10-16T02:00:02.000Z",
				provider: "local",
				model: "fake-model",
				kind: "turn",
				usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000 },
			},
		]);

		const show = run(["sessions", "show", "eeee4444"]);
		assert.equal(show.code, 0, show.stderr);
		assert.ok(show.stdout.includes("请求 1 次"), show.stdout);
		assert.ok(show.stdout.includes("合计 1000 token"), show.stdout);

		const exported = run(["sessions", "export", "eeee4444"]);
		assert.ok(exported.stdout.includes("合计 1000 token"), exported.stdout);
	});

	it("标识前缀唯一时认得出来，找不到时报错", () => {
		const byPrefix = run(["sessions", "show", "bbbb"]);
		assert.equal(byPrefix.code, 0, byPrefix.stderr);

		const missing = run(["sessions", "show", "cccc"]);
		assert.equal(missing.code, 1);
		assert.ok(missing.stderr.includes("没有找到会话"), missing.stderr);
	});

	it("会话文件坏了就明说读不了", () => {
		const file = writeSession("dddd3333", [message("g1", null, "user", "甲的会话")]);
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 1, id: "dddd3333", timestamp: "t", cwd: workRoot })}\n半截的\n`, "utf8");

		const result = run(["sessions", "show", "dddd3333"]);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("无法解析"), result.stderr);
	});

	it("会话插件被禁用时说明看不到会话", () => {
		writeFileSync(
			join(home, "config.toml"),
			['provider = "local"', 'model = "fake-model"', '[plugins]', 'disabled = ["session-plugin"]', ""].join("\n"),
			"utf8",
		);
		const result = run(["sessions", "list"]);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("会话存储没有装载"), result.stderr);

		writeFileSync(
			join(home, "config.toml"),
			['provider = "local"', 'model = "fake-model"', ""].join("\n"),
			"utf8",
		);
	});
});
