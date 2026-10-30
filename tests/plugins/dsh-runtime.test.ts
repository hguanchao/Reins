import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { AnyToolDefinition } from "../../src/tools/contract.ts";
import type { PluginApi, PluginCommand } from "../../src/plugins/host.ts";
import { dshExtensionPlugin, loadDshPlugin } from "../../src/plugins/dsh-runtime.ts";

const created: string[] = [];

after(() => {
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function pluginRoot(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-dsh-"));
	created.push(directory);
	return directory;
}

function fakeApi() {
	const tools: AnyToolDefinition[] = [];
	const commands: PluginCommand[] = [];
	const api = {
		registerTool: (tool: AnyToolDefinition) => tools.push(tool),
		registerCommand: (command: PluginCommand) => commands.push(command),
		registerSandboxBackend: () => {},
		registerPermissionRule: () => {},
		registerSessionStore: () => {},
	};
	return { api: api as PluginApi, tools, commands };
}

/** 手写的最小 dsh 形态插件：inject 声明服务、注册投影与工具、执行期写会话事件。 */
const DSH_PLUGIN = [
	'import { defineTool } from "@deepseek-ai/dsh-tools";',
	"",
	'export const name = "dsh-demo";',
	'export const inject = ["tools", "sessionProjections"];',
	"",
	"export async function apply(ctx, config) {",
	'  await ctx.sessionProjections.register({ key: "demo", init: () => null, apply: (state) => state });',
	"  ctx.tools.register(defineTool({",
	'    name: "dsh_echo",',
	'    description: "Echo text back",',
	'    parameters: { text: { type: "string", required: true, description: "Text to echo" } },',
	"    output: {",
	"      schema: {},",
	'      render: (_args, value) => [{ type: "text", text: `echo: ${value.text}` }],',
	"    },",
	"    execute(args, exec) {",
	'      exec.agent.session.append("demo/write", { text: args.text });',
	"      return { text: args.text };",
	"    },",
	"  }));",
	"}",
	"",
].join("\n");

const CONTEXT = {
	cwd: "C:\\work",
	mode: "print" as const,
	projectTrusted: false,
	sessionDir: "C:\\sessions",
	notify: () => {},
};

describe("dsh 插件装载", () => {
	it("inject 的服务由宿主构造：投影登记、工具进契约、执行走会话事件流", async () => {
		const root = pluginRoot();
		writeFileSync(join(root, "index.js"), DSH_PLUGIN, "utf8");
		const harness = fakeApi();

		const outcome = await loadDshPlugin({ root, file: "index.js", api: harness.api, context: CONTEXT });

		assert.deepEqual(outcome.tools, ["dsh_echo"]);
		assert.deepEqual(outcome.projections, ["demo"]);
		assert.deepEqual(outcome.unavailable, []);
		// dsh-tools 在插件 node_modules 里没有真包：转发指向内置替身
		assert.ok(existsSync(join(root, "node_modules", "@deepseek-ai", "dsh-tools", "index.js")));

		// 替身把字段级 required 转成 JSON Schema 的 required 数组
		const tool = harness.tools[0]!;
		const schema = tool.parameters as { type: string; required?: readonly string[]; properties: Record<string, unknown> };
		assert.equal(schema.type, "object");
		assert.deepEqual(schema.required, ["text"]);
		assert.ok("text" in schema.properties);

		const result = await tool.execute({
			callId: "c1",
			args: { text: "hi" },
			signal: new AbortController().signal,
			onUpdate: () => {},
			workspace: {} as never,
			sandbox: {} as never,
			session: { id: "s", path: null },
		});
		// 结果正文来自插件自己声明的 output.render
		assert.equal(result.content, "echo: hi");
	});

	it("ctx 上不存在的服务在装载期调用即失败，错误写明缺什么", async () => {
		const root = pluginRoot();
		writeFileSync(
			join(root, "index.js"),
			[
				"export async function apply(ctx) {",
				"  await ctx.jobs.start({});",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		// 装载期的缺失服务让插件装载失败；执行期的同源调用只对当次工具调用报错
		await assert.rejects(
			() => loadDshPlugin({ root, file: "index.js", api: fakeApi().api, context: CONTEXT }),
			/ctx\.jobs\.start is not available in Reins/,
		);
	});

	it("没有 apply 导出时报错", async () => {
		const root = pluginRoot();
		writeFileSync(join(root, "index.js"), "export const name = 'x';\n", "utf8");

		await assert.rejects(
			() => loadDshPlugin({ root, file: "index.js", api: fakeApi().api, context: CONTEXT }),
			/does not export apply/,
		);
	});

	it("dshExtensionPlugin 走外部插件管线收集装载结论", async () => {
		const root = pluginRoot();
		writeFileSync(join(root, "index.js"), DSH_PLUGIN, "utf8");
		const harness = fakeApi();

		const collector = dshExtensionPlugin(
			{
				name: "dsh-pack",
				root,
				manifest: "package.json",
				skillDirectories: [],
				mcpServers: [],
				extensions: ["index.js"],
				cordis: true,
				unsupported: [],
				warnings: [],
			},
			CONTEXT,
		);
		await collector.plugin.setup(harness.api);

		assert.equal(collector.outcomes.length, 1);
		assert.deepEqual(collector.outcomes[0]!.tools, ["dsh_echo"]);
		assert.deepEqual(collector.outcomes[0]!.projections, ["demo"]);
	});
});
