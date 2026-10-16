import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { PluginHost, type Plugin } from "../../src/plugins/host.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import type { AnyToolDefinition } from "../../src/tools/contract.ts";

const directory = mkdtempSync(join(tmpdir(), "reins-host-"));

after(() => {
	rmSync(directory, { recursive: true, force: true });
});

function echoTool(name: string): AnyToolDefinition {
	return {
		name,
		description: `工具 ${name}`,
		parameters: { type: "object", properties: {}, required: [] },
		annotations: { readOnly: true, destructive: false, openWorld: false },
		async execute() {
			return { content: name };
		},
	};
}

function makeRegistry(): ToolRegistry {
	return new ToolRegistry(new ResultSpiller(0, directory));
}

describe("插件装载", () => {
	it("装载成功后工具进入注册表", async () => {
		const tools = makeRegistry();
		const host = new PluginHost(tools);
		const failures = await host.load([
			{
				name: "demo-plugin",
				setup(api) {
					api.registerTool(echoTool("demo"));
				},
			},
		]);

		assert.deepEqual(failures, []);
		assert.equal(tools.get("demo")?.name, "demo");
		assert.deepEqual(tools.describe(), [{ name: "demo", source: "plugin" }]);
	});

	it("插件抛错时不留半注册状态", async () => {
		const tools = makeRegistry();
		const host = new PluginHost(tools);
		const failures = await host.load([
			{
				name: "broken-plugin",
				setup(api) {
					api.registerTool(echoTool("half"));
					throw new Error("装到一半坏了");
				},
			},
		]);

		assert.equal(failures.length, 1);
		assert.equal(failures[0].plugin, "broken-plugin");
		assert.match(failures[0].message, /装到一半坏了/);
		// 半生效的插件比完全没加载更难排查，所以队列要丢掉
		assert.equal(tools.get("half"), undefined);
	});

	it("插件不得替换核心工具，冲突会被记为该插件装载失败", async () => {
		const tools = makeRegistry();
		tools.register({ ...echoTool("read"), description: "核心的 read" }, "core");

		const host = new PluginHost(tools);
		const failures = await host.load([
			{
				name: "shadow-plugin",
				setup(api) {
					api.registerTool(echoTool("read"));
				},
			},
		]);

		assert.equal(failures.length, 1);
		assert.match(failures[0].message, /不能被插件替换/);
		assert.equal(tools.get("read")?.description, "核心的 read");
	});

	it("一个插件失败不影响其余插件", async () => {
		const tools = makeRegistry();
		const host = new PluginHost(tools);
		const failures = await host.load([
			{
				name: "bad-plugin",
				setup() {
					throw new Error("坏了");
				},
			},
			{
				name: "good-plugin",
				setup(api) {
					api.registerTool(echoTool("good"));
				},
			},
		]);

		assert.equal(failures.length, 1);
		assert.equal(tools.get("good")?.name, "good");
	});

	it("异步的 setup 会被等待", async () => {
		const tools = makeRegistry();
		const host = new PluginHost(tools);
		await host.load([
			{
				name: "async-plugin",
				async setup(api) {
					await Promise.resolve();
					api.registerTool(echoTool("later"));
				},
			},
		]);
		assert.equal(tools.get("later")?.name, "later");
	});
});

describe("插件命令", () => {
	it("注册并执行命令", async () => {
		const host = new PluginHost(makeRegistry());
		const plugin: Plugin = {
			name: "demo-plugin",
			setup(api) {
				api.registerCommand({
					name: "hello",
					description: "打个招呼",
					async run(args, context) {
						context.print(`你好 ${args}`);
					},
				});
			},
		};
		await host.load([plugin]);

		assert.deepEqual(
			host.commands().map((command) => command.name),
			["hello"],
		);

		const lines: string[] = [];
		await host.runCommand("hello", "世界", { cwd: "/tmp", print: (line) => lines.push(line) });
		assert.deepEqual(lines, ["你好 世界"]);
	});

	it("重复的命令名会被记为该插件装载失败", async () => {
		const host = new PluginHost(makeRegistry());
		const command = { name: "dup", description: "重复的", async run() {} };
		const failures = await host.load([
			{ name: "a-plugin", setup: (api) => api.registerCommand(command) },
			{ name: "b-plugin", setup: (api) => api.registerCommand(command) },
		]);

		assert.equal(failures.length, 1);
		assert.match(failures[0].message, /重复注册/);
	});

	it("执行不存在的命令时报错", async () => {
		const host = new PluginHost(makeRegistry());
		await assert.rejects(
			() => host.runCommand("missing", "", { cwd: "/tmp", print: () => undefined }),
			/没有 \/missing/,
		);
	});
});
