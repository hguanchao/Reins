import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";

import type { CliOptions } from "#src/cli/args.ts";
import type { CommandRunner } from "#src/cli/plugin-command.ts";
import { runPluginCommand } from "#src/cli/plugin-command.ts";

const created: string[] = [];

after(() => {
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function home(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-plugincmd-"));
	created.push(directory);
	return join(directory, "plugins");
}

function pluginOptions(action: "add" | "list", source?: string): CliOptions {
	return {
		command: "plugin",
		prompt: "",
		configPath: undefined,
		providersPath: undefined,
		trust: undefined,
		resume: undefined,
		json: false,
		pluginAction: action,
		pluginSource: source,
	};
}

/** 假 runner：npm install 在 cwd 下铺出包与一个公共依赖；git clone 直接造出目标目录。 */
function fakeRunner(): CommandRunner & { readonly calls: readonly string[] } {
	const calls: string[] = [];
	const runner: CommandRunner = async (command, args, cwd) => {
		calls.push(`${command} ${args.join(" ")}`);
		if (command.includes("npm") && args[0] === "install") {
			const packageName = args[1]!;
			const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
			const directory =
				scope === undefined
					? join(cwd, "node_modules", packageName)
					: join(cwd, "node_modules", scope, packageName.split("/")[1]!);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "index.js"), "export const version = 1;\n", "utf8");
			mkdirSync(join(cwd, "node_modules", "tiny-dep"), { recursive: true });
			writeFileSync(join(cwd, "node_modules", "tiny-dep", "index.js"), "export const dep = 1;\n", "utf8");
		}
		if (command === "git") {
			// git clone --depth 1 <url> <target>：目标在第 5 个参数
			const target = args[4]!;
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "plugin.json"), JSON.stringify({ name: "git-pack" }), "utf8");
		}
		return { code: 0, stderr: "" };
	};
	return Object.assign(runner, { calls });
}

describe("插件安装", () => {
	it("本地目录：复制内容，node_modules 与 .git 不跟过去", async () => {
		const directory = home();
		const source = mkdtempSync(join(tmpdir(), "reins-src-"));
		created.push(source);
		mkdirSync(join(source, "skills", "alpha"), { recursive: true });
		writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "demo-pack" }), "utf8");
		writeFileSync(join(source, "skills", "alpha", "SKILL.md"), "---\nname: demo\n---\n", "utf8");
		mkdirSync(join(source, "node_modules"), { recursive: true });
		writeFileSync(join(source, "node_modules", "junk.js"), "", "utf8");

		const code = await runPluginCommand(pluginOptions("add", source), fakeRunner(), directory);

		assert.equal(code, 0);
		// 目录名取来源目录的名字；清单里的 name 只用于重名检查与报告
		const target = join(directory, basename(source));
		assert.ok(existsSync(join(target, "plugin.json")));
		assert.ok(existsSync(join(target, "skills", "alpha", "SKILL.md")));
		assert.equal(existsSync(join(target, "node_modules")), false);
	});

	it("重名目录拒绝安装", async () => {
		const directory = home();
		const source = mkdtempSync(join(tmpdir(), "reins-src-"));
		created.push(source);
		writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "same" }), "utf8");
		// 本地来源的目录名就是目标名：预占同一个名字才会撞上
		mkdirSync(join(directory, basename(source)), { recursive: true });

		const code = await runPluginCommand(pluginOptions("add", source), fakeRunner(), directory);

		assert.equal(code, 1);
	});

	it("git 来源：浅克隆后给带依赖的清单跑 npm install", async () => {
		const directory = home();
		const runner = fakeRunner();

		const code = await runPluginCommand(
			pluginOptions("add", "https://github.com/acme/git-pack.git"),
			runner,
			directory,
		);

		assert.equal(code, 0);
		assert.ok(runner.calls.some((call) => call.startsWith("git clone --depth 1")));
		// 克隆下来的清单带 dependencies 时才装；这里没写，所以只有 clone 一次调用
		assert.equal(runner.calls.filter((call) => call.includes("install")).length, 0);
		assert.ok(existsSync(join(directory, "git-pack", "plugin.json")));
	});

	it("npm 来源：包与依赖一起落地，包自身不出现在依赖里", async () => {
		const directory = home();
		const runner = fakeRunner();

		const code = await runPluginCommand(pluginOptions("add", "left-pad"), runner, directory);

		assert.equal(code, 0);
		assert.ok(existsSync(join(directory, "left-pad", "index.js")));
		assert.ok(existsSync(join(directory, "left-pad", "node_modules", "tiny-dep", "index.js")));
		assert.equal(existsSync(join(directory, "left-pad", "node_modules", "left-pad")), false);
	});

	it("npm 来源装不出包目录时报错", async () => {
		const directory = home();
		const runner: CommandRunner = async () => ({ code: 0, stderr: "" });

		const code = await runPluginCommand(pluginOptions("add", "ghost-pkg"), runner, directory);

		assert.equal(code, 1);
	});

	it("list 在空目录时给出说明", async () => {
		const code = await runPluginCommand(pluginOptions("list"), fakeRunner(), home());
		assert.equal(code, 0);
	});
});
