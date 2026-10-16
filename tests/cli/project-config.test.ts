import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";

/**
 * 工作区自带配置的读取与信任。
 *
 * 走真正的命令行，因为要验证的正是「终端里跑起来之后到底生效了什么」：信任的判定、两份配置的
 * 合并、以及把结论写回用户配置。这些串起来才构成一个可用的功能。
 */

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(PROJECT_ROOT, "src", "cli", "index.ts");
const runFile = promisify(execFile);

const home = mkdtempSync(join(tmpdir(), "reins-project-home-"));
const work = mkdtempSync(join(tmpdir(), "reins-project-work-"));

beforeEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
	writeUserFiles();
});

after(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
});

const USER_CONFIG = [
	"# 我自己的说明",
	'provider = "local"',
	'model = "m"   # 换成别的模型就改这里',
	'sandbox = "off"',
	'approval = "ask"',
	"",
].join("\n");

function writeUserFiles(): void {
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "config.toml"), USER_CONFIG, "utf8");
	writeFileSync(
		join(home, "providers.json"),
		JSON.stringify({
			providers: {
				local: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", models: [{ id: "m" }] },
			},
		}),
		"utf8",
	);
}

function writeProjectConfig(content: string): void {
	mkdirSync(join(work, ".reins"), { recursive: true });
	writeFileSync(join(work, ".reins", "config.toml"), content, "utf8");
}

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function run(args: readonly string[]): Promise<RunResult> {
	try {
		const { stdout, stderr } = await runFile(process.execPath, [ENTRY, ...args], {
			cwd: work,
			encoding: "utf8",
			env: { ...process.env, REINS_HOME: home },
			timeout: 30_000,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

describe("工作区自带的配置", () => {
	it("没有信任时整体跳过，并说明怎么用", async () => {
		writeProjectConfig('provider = "local"\nmodel = "m"\nspill_threshold = 111\nsandbox = "read-only"\n');

		const result = await run(["config", "check"]);

		assert.equal(result.code, 0);
		assert.ok(result.stderr.includes("已跳过"), `标准错误：${result.stderr}`);
		assert.ok(result.stderr.includes("--trust"));
		// 项目里的设置没有生效
		assert.ok(result.stdout.includes("off"), "沙箱应当仍是用户设置的 off");
		assert.ok(!result.stdout.includes("read-only"));
	});

	it("信任之后项目设置生效，用户的注释原样保留", async () => {
		writeProjectConfig('provider = "local"\nmodel = "m"\nspill_threshold = 111\nsandbox = "read-only"\n');

		const result = await run(["config", "check", "--trust"]);

		assert.equal(result.code, 0, `标准错误：${result.stderr}`);
		assert.ok(result.stdout.includes("read-only"), `标准输出：${result.stdout}`);
		assert.ok(result.stdout.includes("111"), `标准输出：${result.stdout}`);
		// 报告里点明生效的是哪几份配置
		assert.ok(result.stdout.includes("config.toml + "));

		const written = readFileSync(join(home, "config.toml"), "utf8");
		assert.ok(written.includes("# 我自己的说明"));
		assert.ok(written.includes('model = "m"   # 换成别的模型就改这里'));
		assert.ok(written.includes("trusted"));
	});

	it("信任被记下之后，下次不必再给 --trust", async () => {
		writeProjectConfig('provider = "local"\nmodel = "m"\nspill_threshold = 222\n');

		await run(["config", "check", "--trust"]);
		const second = await run(["config", "check"]);

		assert.equal(second.code, 0);
		assert.ok(second.stdout.includes("222"), `标准输出：${second.stdout}`);
		assert.ok(!second.stderr.includes("已跳过"));
	});

	it("--no-trust 之后项目设置不再生效", async () => {
		writeProjectConfig('provider = "local"\nmodel = "m"\nspill_threshold = 333\n');

		await run(["config", "check", "--trust"]);
		await run(["config", "check", "--no-trust"]);
		const third = await run(["config", "check"]);

		assert.ok(!third.stdout.includes("333"), `标准输出：${third.stdout}`);
		assert.ok(third.stderr.includes("已跳过"));
	});

	it("项目想放宽安全姿态时明确报错，而不是照做", async () => {
		writeProjectConfig('provider = "local"\nmodel = "m"\napproval = "yolo"\n');

		const result = await run(["config", "check", "--trust"]);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("不能把 approval 从 ask 放宽到 yolo"), `标准错误：${result.stderr}`);
	});

	it("显式指定配置文件时不叠加工作区里的那份", async () => {
		writeProjectConfig('provider = "local"\nmodel = "m"\nspill_threshold = 444\n');

		const result = await run([
			"config",
			"check",
			"--config",
			join(home, "config.toml"),
			"--providers",
			join(home, "providers.json"),
		]);

		assert.equal(result.code, 0);
		assert.ok(!result.stdout.includes("444"));
		assert.ok(!result.stderr.includes("已跳过"));
	});
});
