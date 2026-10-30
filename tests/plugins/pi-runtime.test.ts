import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { AnyToolDefinition } from "../../src/tools/contract.ts";
import type { PluginApi, PluginCommand } from "../../src/plugins/host.ts";
import { ensureShimPackages, loadPiExtension, piExtensionPlugin } from "../../src/plugins/pi-runtime.ts";

const created: string[] = [];

function pluginRoot(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-pi-"));
	created.push(directory);
	return directory;
}

after(() => {
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/** 收集注册项的假宿主 API。 */
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

const ECHO_EXTENSION = [
	'import { Type } from "typebox";',
	"",
	"export default function (pi) {",
	'  pi.registerTool({',
	'    name: "echo_tool",',
	'    description: "Echo text back",',
	'    promptSnippet: "Echo the given text",',
	"    parameters: Type.Object({ text: Type.Optional(Type.String()) }),",
	"    execute: async (_id, params, _signal, _onUpdate, ctx) => ({",
	'      content: [{ type: "text", text: `${params.text ?? "(empty)"} @ ${ctx.cwd}` }],',
	"    }),",
	"  });",
	'  pi.registerCommand("hello", {',
	'    description: "Say hello",',
	'    handler: async (args, ctx) => { ctx.ui.notify(`hello ${args}`); },',
	"  });",
	'  pi.on("tool_call", async () => {});',
	"  pi.appendEntry({ type: \"note\" });",
	"}",
	"",
].join("\n");

const CONTEXT = {
	cwd: "C:\\work",
	mode: "tui" as const,
	projectTrusted: false,
	sessionDir: "C:\\sessions",
	notify: () => {},
};

describe("pi 扩展装载", () => {
	it("工具与命令被注册，事件只计数，缺失的 API 进报告", async () => {
		const root = pluginRoot();
		writeFileSync(join(root, "index.ts"), ECHO_EXTENSION, "utf8");
		const harness = fakeApi();

		const outcome = await loadPiExtension({ root, file: "index.ts", api: harness.api, context: CONTEXT });

		assert.deepEqual(outcome.tools, ["echo_tool"]);
		assert.deepEqual(outcome.commands, ["hello"]);
		assert.equal(outcome.handlers, 1);
		assert.deepEqual(outcome.unavailable, ["pi.appendEntry"]);

		// 扩展 import 的包名解析到了宿主铺好的转发文件
		assert.ok(existsSync(join(root, "node_modules", "typebox", "index.js")));
		assert.ok(existsSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "index.js")));

		// 工具参数：Optional 不进 required，全部可选时连 required 键都没有
		const tool = harness.tools[0]!;
		const schema = tool.parameters as { type: string; required?: readonly string[] };
		assert.equal(schema.type, "object");
		assert.equal(schema.required, undefined);

		// 执行结果映射成宿主的纯文本，ctx.cwd 来自宿主
		const result = await tool.execute({
			callId: "c1",
			args: { text: "hi" },
			signal: new AbortController().signal,
			onUpdate: () => {},
			workspace: {} as never,
			sandbox: {} as never,
			session: { id: "s", path: null },
		});
		assert.deepEqual(result, { content: "hi @ C:\\work" });
	});

	it("扩展调用缺失的 ctx 方法时报错并记进装载结果", async () => {
		const root = pluginRoot();
		writeFileSync(
			join(root, "index.ts"),
			[
				"export default function (pi) {",
				'  pi.registerCommand("pick", {',
				'    handler: async (_args, ctx) => { await ctx.ui.select("pick", ["a"]); },',
				"  });",
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		const harness = fakeApi();

		const outcome = await loadPiExtension({ root, file: "index.ts", api: harness.api, context: CONTEXT });
		assert.deepEqual(outcome.tools, []);
		assert.deepEqual(outcome.commands, ["pick"]);

		const run = harness.commands[0]!.run;
		// 命令执行期缺失的 ctx 方法当场报错；装载结果只覆盖装载期间的调用
		await assert.rejects(
			() => run("", { cwd: "C:\\work", print: () => {} }),
			/ctx\.ui\.select is not available in Reins/,
		);
	});

	it("默认导出不是函数时报错", async () => {
		const root = pluginRoot();
		writeFileSync(join(root, "index.ts"), "export default 42;\n", "utf8");

		await assert.rejects(
			() => loadPiExtension({ root, file: "index.ts", api: fakeApi().api, context: CONTEXT }),
			/The default export is not a function/,
		);
	});

	it("shim 转发只在内容变化时写入", () => {
		const root = pluginRoot();
		ensureShimPackages(root);
		const forwarder = join(root, "node_modules", "typebox", "index.js");
		const before = readFileSync(forwarder, "utf8");
		ensureShimPackages(root);
		assert.equal(readFileSync(forwarder, "utf8"), before);
	});

	it("piExtensionPlugin 走外部插件管线收集装载结论", async () => {
		const root = pluginRoot();
		writeFileSync(join(root, "index.ts"), ECHO_EXTENSION, "utf8");
		const harness = fakeApi();

		const collector = piExtensionPlugin(
			{
				name: "pi-pack",
				root,
				manifest: "package.json#pi",
				skillDirectories: [],
				mcpServers: [],
				extensions: ["index.ts"],
				cordis: false,
				unsupported: [],
				warnings: [],
			},
			CONTEXT,
		);
		await collector.plugin.setup(harness.api);

		assert.equal(collector.outcomes.length, 1);
		assert.deepEqual(collector.outcomes[0]!.tools, ["echo_tool"]);
		assert.deepEqual(collector.outcomes[0]!.commands, ["hello"]);
	});
});
