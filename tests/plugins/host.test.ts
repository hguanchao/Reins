import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PluginHost, type Plugin, type PluginApi } from "../../src/plugins/host.ts";
import { PermissionPolicy } from "../../src/permission/policy.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/tools/contract.ts";

function noSpill(): ResultSpiller {
	return new ResultSpiller(0, "");
}
const ALLOW_GATE = { check: async () => ({ allowed: true, reason: "" }) };

function toolNamed(name: string): ToolDefinition {
	return {
		name,
		description: "",
		parameters: { type: "object", properties: {} },
		annotations: { readOnly: true, destructive: false, openWorld: false },
		execute: async () => ({ content: "" }),
	};
}

function pluginOf(name: string, setup: (api: PluginApi) => void | Promise<void>): Plugin {
	return { name, setup };
}

async function hostWith(...plugins: readonly Plugin[]): Promise<{ host: PluginHost; failures: unknown[]; registry: ToolRegistry; policy: PermissionPolicy }> {
	const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
	const policy = new PermissionPolicy("ask");
	const host = new PluginHost(registry, policy);
	const failures = await host.load(plugins) as unknown[];
	return { host, failures, registry, policy };
}

describe("插件宿主", () => {
	it("装载成功的插件把注册项一并交出", async () => {
		const { host, registry, policy } = await hostWith(
			pluginOf("first", (api) => {
				api.registerTool(toolNamed("first_tool"));
				api.registerCommand({ name: "first-cmd", description: "", run: async () => undefined });
				api.registerPermissionRule({ decision: "deny", reason: "blocked", matches: () => false });
				api.registerSandboxBackend({ id: "fake", available: false, wrap: () => undefined });
				api.registerSessionStore({} as never);
			}),
		);
		assert.equal(registry.get("first_tool")?.name, "first_tool");
		assert.deepEqual(registry.describe(), [{ name: "first_tool", source: "bundled" }]);
		assert.deepEqual(host.commands().map((command) => command.name), ["first-cmd"]);
		assert.equal(policy.ruleCount(), 1);
		assert.equal(host.backends().length, 1);
		assert.ok(host.sessionStore() !== undefined);
	});

	it("随包插件与外部插件的来源分开标记", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const host = new PluginHost(registry, new PermissionPolicy("ask"));
		await host.load([pluginOf("bundled", (api) => api.registerTool(toolNamed("bundled_tool")))]);
		await host.loadExternal([pluginOf("external", (api) => api.registerTool(toolNamed("external_tool")))]);

		assert.deepEqual(registry.describe(), [
			{ name: "bundled_tool", source: "bundled" },
			{ name: "external_tool", source: "plugin" },
		]);
	});

	it("装载半途抛错的插件不留下任何注册项", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const policy = new PermissionPolicy("ask");
		const host = new PluginHost(registry, policy);
		const failures = await host.load([
			pluginOf("bad", (api) => {
				api.registerTool(toolNamed("half_tool"));
				throw new Error("boom");
			}),
		]);

		assert.equal(failures.length, 1);
		assert.deepEqual(failures[0], { plugin: "bad", message: "boom" });
		assert.equal(registry.get("half_tool"), undefined);
	});

	it("单个插件失败不影响后面的", async () => {
		const { failures, registry } = await hostWith(
			pluginOf("bad", () => {
				throw new Error("no");
			}),
			pluginOf("good", (api) => {
				api.registerTool(toolNamed("good_tool"));
			}),
		);
		assert.equal(failures.length, 1);
		assert.equal(registry.get("good_tool")?.name, "good_tool");
	});

	it("命令重名报出哪一条", async () => {
		const { host, failures } = await hostWith(
			pluginOf("a", (api) => {
				api.registerCommand({ name: "dup", description: "", run: async () => undefined });
			}),
			pluginOf("b", (api) => {
				api.registerCommand({ name: "dup", description: "", run: async () => undefined });
			}),
		);
		// 第二个插件的整次装载失败:第一个已入库的不受影响
		assert.equal(failures.length, 1);
		assert.match((failures as { message: string }[])[0]!.message, /already registered/);
		assert.deepEqual(host.commands().map((command) => command.name), ["dup"]);
	});

	it("会话存储只允许一个", async () => {
		const { failures } = await hostWith(
			pluginOf("one", (api) => {
				api.registerSessionStore({} as never);
			}),
			pluginOf("two", (api) => {
				api.registerSessionStore({} as never);
			}),
		);
		assert.equal(failures.length, 1);
		assert.match((failures as { message: string }[])[0]!.message, /only one is allowed/);
	});

	it("宿主自己的命令与插件命令同一份清单且不许重名", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const host = new PluginHost(registry, new PermissionPolicy("ask"));
		host.addCommand({ name: "help", description: "", run: async () => undefined });
		assert.throws(() => host.addCommand({ name: "help", description: "", run: async () => undefined }), /already registered/);

		await host.load([
			pluginOf("p", (api) => {
				api.registerCommand({ name: "help", description: "", run: async () => undefined });
			}),
		]);

		let ran = "";
		await host.runCommand("help", "", { cwd: ".", print: (line) => (ran = line) });
		void ran;
	});

	it("运行不存在的命令报错", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const host = new PluginHost(registry, new PermissionPolicy("ask"));
		await assert.rejects(
			() => host.runCommand("nothing", "", { cwd: ".", print: () => undefined }),
			/No such command: \/nothing/,
		);
	});

	it("装载完成后插件仍可补注册:远端连上才知道能力的情形", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const host = new PluginHost(registry, new PermissionPolicy("ask"));
		let api: PluginApi | undefined;
		await host.loadExternal([
			pluginOf("lazy", (given) => {
				api = given;
			}),
		]);
		api!.registerTool(toolNamed("late_tool"));
		assert.ok(registry.get("late_tool") !== undefined);
	});
});
