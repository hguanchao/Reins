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

	it("会话存储后注册者替换先前的实现", async () => {
		// 内置实现先装好，插件提供自己的实现即替换：条目从此写到新存储里
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const host = new PluginHost(registry, new PermissionPolicy("ask"), {
			sessionStore: { builtin: true } as never,
		});
		const failures = await host.load([
			pluginOf("custom", (api) => {
				api.registerSessionStore({ custom: true } as never);
			}),
		]);

		assert.deepEqual(failures, []);
		assert.deepEqual(host.sessionStore(), { custom: true });
	});

	it("内置实现缺席时插件提供的会话存储生效", async () => {
		const { host } = await hostWith(
			pluginOf("only", (api) => {
				api.registerSessionStore({ custom: true } as never);
			}),
		);
		assert.deepEqual(host.sessionStore(), { custom: true });
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

	it("装载完成后补注册的命令也要生效，而不是被静默丢弃", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const host = new PluginHost(registry, new PermissionPolicy("ask"));
		let api: PluginApi | undefined;
		await host.loadExternal([
			pluginOf("lazy", (given) => {
				api = given;
			}),
		]);
		api!.registerCommand({ name: "late", description: "", run: async () => undefined });
		assert.deepEqual(host.commands().map((command) => command.name), ["late"]);
	});

	it("装载中途撞上重名时，整批注册项都不落地", async () => {
		// 半装载状态最难排查：报的是装载失败，模型却能看见前面几个工具
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		registry.register(toolNamed("taken"), "bundled");
		const host = new PluginHost(registry, new PermissionPolicy("ask"));

		const failures = await host.load([
			pluginOf("partial", (api) => {
				api.registerTool(toolNamed("first_ok"));
				api.registerTool(toolNamed("taken"));
			}),
		]);

		assert.equal(failures.length, 1);
		assert.equal(registry.get("first_ok"), undefined);
	});

	it("插件不能替换内置工具", async () => {
		// 内置工具是「能改代码」这件事本身，被换掉之后使用者很难察觉
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		registry.register(toolNamed("read"), "core");
		const host = new PluginHost(registry, new PermissionPolicy("ask"));

		const failures = await host.load([
			pluginOf("hijack", (api) => {
				api.registerTool(toolNamed("read"));
			}),
		]);

		// 装载期的预检先撞上重名，注册表那层「核心工具不可替换」是它的第二道闸
		assert.equal(failures.length, 1);
		assert.match(failures[0]!.message, /already registered|cannot be replaced/);
		assert.equal(registry.describe()[0]!.source, "core");
	});

	it("内置后端在构造时装好，插件按标识替换", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const builtin = { id: "seatbelt", available: false, wrap: () => undefined };
		const host = new PluginHost(registry, new PermissionPolicy("ask"), { backends: [builtin] });
		assert.deepEqual(host.backends().map((backend) => backend.id), ["seatbelt"]);

		const replacement = { id: "seatbelt", available: true, wrap: () => "wrapped" };
		await host.load([pluginOf("swap", (api) => api.registerSandboxBackend(replacement))]);

		// 同标识即替换，而不是让两份实现并存、由装配处去猜该用哪个
		assert.deepEqual(host.backends(), [replacement]);
	});

	it("不同标识的后端并列，保留原有顺序", async () => {
		const registry = new ToolRegistry(noSpill(), ALLOW_GATE as never);
		const first = { id: "first", available: false, wrap: () => undefined };
		const host = new PluginHost(registry, new PermissionPolicy("ask"), { backends: [first] });

		const second = { id: "second", available: false, wrap: () => undefined };
		await host.load([pluginOf("extra", (api) => api.registerSandboxBackend(second))]);

		assert.deepEqual(host.backends().map((backend) => backend.id), ["first", "second"]);
	});
});
