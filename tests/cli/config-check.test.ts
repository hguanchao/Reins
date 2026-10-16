import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(PROJECT_ROOT, "src", "cli", "index.ts");

const MODELS = JSON.stringify({
	providers: {
		"example-openai": {
			name: "示例端点",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			apiKey: "${EXAMPLE_KEY}",
			models: [
				{ id: "gpt-5.2", contextWindow: 256000, maxTokens: 8192 },
				{ id: "gpt-5.2-mini", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } },
			],
		},
	},
});

const workDir = mkdtempSync(join(tmpdir(), "reins-cli-"));
after(() => {
	rmSync(workDir, { recursive: true, force: true });
});

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

function run(args: readonly string[]): RunResult {
	try {
		const stdout = execFileSync(process.execPath, [ENTRY, ...args], {
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

function writeFixture(name: string, content: string): string {
	const path = join(workDir, name);
	writeFileSync(path, content, "utf8");
	return path;
}

describe("reins config check", () => {
	it("校验通过时列出解析结果并以 0 退出", () => {
		const config = writeFixture("ok.toml", 'provider = "example-openai"\nmodel = "gpt-5.2"\n');
		const models = writeFixture("ok-models.json", MODELS);

		const result = run(["config", "check", "--config", config, "--models", models]);

		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes("当前模型"));
		assert.ok(result.stdout.includes("example-openai"));
		assert.ok(result.stdout.includes("gpt-5.2"));
		assert.ok(result.stdout.includes("openai-completions"));
		// 未声明的量照实写出来，不用数字顶替
		assert.ok(result.stdout.includes("未声明"));
		// 两个模型都列出来，并标出当前选中的那个
		assert.ok(result.stdout.includes("gpt-5.2-mini"));
	});

	it("把实际生效的默认值写出来", () => {
		const config = writeFixture("defaults.toml", 'provider = "example-openai"\nmodel = "gpt-5.2"\n');
		const models = writeFixture("defaults-models.json", MODELS);

		const result = run(["config", "check", "--config", config, "--models", models]);

		assert.ok(result.stdout.includes("ask"));
		assert.ok(result.stdout.includes("off"));
		assert.ok(result.stdout.includes("8192"));
	});

	it("配置写错时以 1 退出，并按文件:行:列 报错", () => {
		const config = writeFixture("bad.toml", 'provider = "example-openai"\nmodel = "gpt-5.2"\napproval = "always"\n');
		const models = writeFixture("bad-models.json", MODELS);

		const result = run(["config", "check", "--config", config, "--models", models]);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("bad.toml:3:1"));
		assert.ok(result.stderr.includes("只能是"));
	});

	it("模型对不上时以 1 退出并列出可选项", () => {
		const config = writeFixture("mismatch.toml", 'provider = "example-openai"\nmodel = "nope"\n');
		const models = writeFixture("mismatch-models.json", MODELS);

		const result = run(["config", "check", "--config", config, "--models", models]);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("没有模型 nope"));
		assert.ok(result.stderr.includes("gpt-5.2"));
	});

	it("文件不存在时给出可读的错误", () => {
		const result = run([
			"config",
			"check",
			"--config",
			join(workDir, "missing.toml"),
			"--models",
			join(workDir, "missing.json"),
		]);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("读取失败"));
	});

	it("用法错误时以 2 退出", () => {
		const result = run(["--nope"]);
		assert.equal(result.code, 2);
		assert.ok(result.stderr.includes("无法识别的选项"));
	});
});

describe("reins 帮助与版本", () => {
	it("无参数时要求终端：测试里的标准输出不是终端", () => {
		const result = run([]);
		assert.equal(result.code, 2);
		assert.ok(result.stderr.includes("交互界面需要终端"));
	});

	it("打印帮助", () => {
		const result = run(["--help"]);
		assert.equal(result.code, 0);
		assert.ok(result.stdout.includes("用法"));
	});

	it("打印版本号", () => {
		const result = run(["--version"]);
		assert.equal(result.code, 0);
		assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
	});
});
