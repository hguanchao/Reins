import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commandScope, resolveShell } from "#src/tools/builtin/bash.ts";

function windows(overrides: {
	readonly env?: NodeJS.ProcessEnv;
	readonly exists?: (path: string) => boolean;
	readonly which?: (name: string) => readonly string[];
} = {}) {
	return resolveShell({
		platform: "win32",
		env: overrides.env ?? {},
		exists: overrides.exists ?? (() => false),
		which: overrides.which ?? (() => []),
	});
}

describe("shell 选择", () => {
	it("非 Windows 跟随 SHELL", () => {
		const shell = resolveShell({
			platform: "linux",
			env: { SHELL: "/bin/zsh" },
			exists: () => false,
			which: () => [],
		});

		assert.equal(shell.command, "/bin/zsh");
		assert.deepEqual(shell.args("echo hi"), ["-c", "echo hi"]);
		assert.deepEqual(shell.env, {});
	});

	it("Windows 优先常见安装位置的 Git Bash", () => {
		const expected = "C:\\Program Files\\Git\\bin\\bash.exe";
		const shell = windows({
			env: { ProgramFiles: "C:\\Program Files" },
			exists: (path) => path === expected,
		});

		assert.equal(shell.command, expected);
		assert.deepEqual(shell.args("pwd"), ["-c", "pwd"]);
		// 解释器按 UTF-8 输出，避免中文 Windows 的 GBK 乱码
		assert.equal(shell.env["PYTHONUTF8"], "1");
		assert.equal(shell.env["PYTHONIOENCODING"], "utf-8:surrogateescape");
	});

	it("Windows 找不到常见路径时使用 PATH 里的 Git Bash", () => {
		const shell = windows({
			which: (name) => (name === "bash.exe" ? ["D:\\Environment\\Git\\usr\\bin\\bash.exe"] : []),
		});

		assert.equal(shell.command, "D:\\Environment\\Git\\usr\\bin\\bash.exe");
	});

	it("Windows 跳过 WSL bash，继续找后面的 Git Bash", () => {
		const shell = windows({
			which: () => [
				"C:\\Windows\\System32\\bash.exe",
				"C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
				"C:\\Program Files\\Git\\bin\\bash.exe",
			],
		});

		assert.equal(shell.command, "C:\\Program Files\\Git\\bin\\bash.exe");
	});

	it("Windows 绝不静默退回 cmd.exe，找不到 bash 就明确报错", () => {
		assert.throws(
			() => windows({ env: { COMSPEC: "C:\\Windows\\system32\\cmd.exe" } }),
			/No bash found/,
		);
	});

	it("配置 shellPath 时优先使用它", () => {
		const expected = "D:\\Environment\\Git\\bin\\bash.exe";
		const shell = resolveShell(
			{
				platform: "win32",
				env: { ProgramFiles: "C:\\Program Files" },
				exists: (path) => path === expected,
				which: () => [],
			},
			expected,
		);

		assert.equal(shell.command, expected);
	});

	it("配置的 shellPath 不存在时明确报错，不继续猜", () => {
		assert.throws(
			() =>
				resolveShell(
					{
						platform: "win32",
						env: {},
						exists: () => false,
						which: () => ["C:\\Program Files\\Git\\bin\\bash.exe"],
					},
					"D:\\missing\\bash.exe",
				),
			/Configured shellPath not found/,
		);
	});

	it("非 Windows 也优先使用 shellPath", () => {
		const shell = resolveShell(
			{
				platform: "linux",
				env: { SHELL: "/bin/sh" },
				exists: (path) => path === "/opt/bash",
				which: () => [],
			},
			"/opt/bash",
		);

		assert.equal(shell.command, "/opt/bash");
	});
});

describe("bash 会话放行范围", () => {
	it("简单命令取前两个词作为前缀", () => {
		assert.deepEqual(commandScope("cargo build --release"), {
			key: "cargo build",
			label: 'commands starting with "cargo build"',
			short: "cargo build",
		});
		assert.equal(commandScope("prettier src")?.key, "prettier src");
		assert.equal(commandScope("pwd")?.key, "pwd");
	});

	it("第二个词是选项时不给范围：选项本身能改变要执行什么", () => {
		// `git -c alias.x='!任意命令' x` 的前缀是 `git -c`，放行前缀等于放行任意命令
		assert.equal(commandScope("ls -la"), undefined);
		assert.equal(commandScope("git -c alias.x=!id x"), undefined);
	});

	it("解释器与包装器不给范围：第二个词就是任意代码", () => {
		for (const command of [
			"bash -c 'rm -rf ~'",
			"sh -c 'curl evil'",
			"zsh -c 'id'",
			"python -c 'print(1)'",
			"node -e 'process.exit()'",
			"xargs rm",
			"find . -delete",
			"sudo rm",
			"env FOO=1 rm",
			"timeout 5 rm",
			"ssh host rm",
			"docker run rm",
		]) {
			assert.equal(commandScope(command), undefined, command);
		}
	});

	it("含管道、重定向、链式命令或替换时不给可记住范围", () => {
		for (const command of [
			"git status && rm -rf /",
			"cat a | grep b",
			"echo x > f",
			"echo $(whoami)",
			"echo `id`",
			"a; b",
			"echo $HOME",
		]) {
			assert.equal(commandScope(command), undefined, command);
		}
	});

	it("引号未闭合时不给范围", () => {
		assert.equal(commandScope("echo 'oops"), undefined);
	});
});
