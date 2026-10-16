import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { PermissionPolicy } from "../../src/permission/policy.ts";
import { ExternalPlugins, discoverPlugins, importPlugin } from "../../src/plugins/external.ts";
import { PluginHost, type PluginApi } from "../../src/plugins/host.ts";
import type { AnyToolDefinition } from "../../src/tools/contract.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import { allowAllGate } from "../tools/helpers.ts";

/**
 * 外部插件。
 *
 * 要钉住的是两件事：改完文件重载一次就生效（不重新编译、不重启），以及重载之后旧的那一代
 * 连注册的入口都不再作数。后者是「插件间只能经宿主服务通信」的落点——两条插件之间没有共享
 * 的引用，只有宿主给的 api，而 api 是分代的。
 */

const directories: string[] = [];

after(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function makeDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-external-"));
	directories.push(directory);
	return directory;
}

/**
 * 造一个外部插件文件。
 *
 * description 既是工具的描述、也是工具的返回值、还是命令的输出，因此「重载之后哪一版生效」
 * 一眼看得出来。setup 里把 api 挂到 globalThis 上，用例才能拿到上一代的入口去验证它已经失效。
 */
function pluginSource(name: string, description: string): string {
	return `globalThis.__reinsExternalTestApi = undefined;
export default {
	name: ${JSON.stringify(name)},
	setup(api) {
		globalThis.__reinsExternalTestApi = api;
		api.registerTool({
			name: ${JSON.stringify(`${name}_tool`)},
			description: ${JSON.stringify(description)},
			parameters: { type: "object", properties: {}, required: [] },
			annotations: { readOnly: true, destructive: false, openWorld: false },
			async execute() {
				return { content: ${JSON.stringify(description)} };
			},
		});
		api.registerCommand({
			name: ${JSON.stringify(name)},
			description: ${JSON.stringify(description)},
			async run(_args, context) {
				context.print(${JSON.stringify(description)});
			},
		});
	},
};
`;
}

function coreTool(name: string): AnyToolDefinition {
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

interface Fixture {
	readonly directory: string;
	readonly registry: ToolRegistry;
	readonly host: PluginHost;
	readonly external: ExternalPlugins;
}

function fixture(): Fixture {
	const directory = makeDirectory();
	const registry = new ToolRegistry(new ResultSpiller(0, tmpdir()), allowAllGate);
	const host = new PluginHost(registry, new PermissionPolicy("yolo"));
	return { directory, registry, host, external: new ExternalPlugins({ directory, host }) };
}

/** 上一代插件拿到的入口。setup 会把它挂在这里。 */
function lastApi(): PluginApi | undefined {
	return (globalThis as unknown as { __reinsExternalTestApi?: PluginApi }).__reinsExternalTestApi;
}

describe("发现外部插件", () => {
	it("只认顶层的 .ts 文件，按名字排序", () => {
		const directory = makeDirectory();
		writeFileSync(join(directory, "b-plugin.ts"), pluginSource("b-plugin", "乙"));
		writeFileSync(join(directory, "a-plugin.ts"), pluginSource("a-plugin", "甲"));
		writeFileSync(join(directory, "notes.md"), "# 说明");
		writeFileSync(join(directory, "types.d.ts"), "export {};\n");

		assert.deepEqual(
			discoverPlugins(directory).map((source) => source.name),
			["a-plugin", "b-plugin"],
		);
	});

	it("目录不存在时当作没有插件，不报错", () => {
		assert.deepEqual(discoverPlugins(join(tmpdir(), "reins-不存在的插件目录")), []);
	});
});

describe("装载单个插件文件", () => {
	it("标识与文件名不一致时拒绝：禁用清单与界面都按标识认人", async () => {
		const directory = makeDirectory();
		const file = join(directory, "demo.ts");
		writeFileSync(file, pluginSource("别的名字", "甲"));

		await assert.rejects(() => importPlugin({ name: "demo", file }, 1), /与文件名 demo 不一致/);
	});

	it("没有默认导出时拒绝", async () => {
		const directory = makeDirectory();
		const file = join(directory, "demo.ts");
		writeFileSync(file, "export const x = 1;\n");

		await assert.rejects(() => importPlugin({ name: "demo", file }, 1), /没有默认导出/);
	});

	it("文件本身有问题时把原因带出来", async () => {
		const directory = makeDirectory();
		const file = join(directory, "demo.ts");
		writeFileSync(file, "export default { name: 'demo', setup( { }\n");

		await assert.rejects(() => importPlugin({ name: "demo", file }, 1), /装载失败/);
	});
});

describe("装载与重载", () => {
	it("装载之后工具与命令都进了宿主，源码直接就是运行产物", async () => {
		const f = fixture();
		writeFileSync(join(f.directory, "demo.ts"), pluginSource("demo", "第一版"));

		assert.deepEqual(await f.external.load(), []);
		assert.equal(f.registry.get("demo_tool")?.description, "第一版");
		assert.deepEqual(
			f.host.commands().map((command) => command.name),
			["demo"],
		);

		const lines: string[] = [];
		await f.host.runCommand("demo", "", { cwd: f.directory, print: (line) => lines.push(line) });
		assert.deepEqual(lines, ["第一版"]);
	});

	it("改完文件重载一次就生效，不需要重启", async () => {
		const f = fixture();
		const file = join(f.directory, "demo.ts");
		writeFileSync(file, pluginSource("demo", "第一版"));
		await f.external.load();

		writeFileSync(file, pluginSource("demo", "第二版"));
		assert.deepEqual(await f.external.load(), []);

		assert.equal(f.registry.get("demo_tool")?.description, "第二版");
		const lines: string[] = [];
		await f.host.runCommand("demo", "", { cwd: f.directory, print: (line) => lines.push(line) });
		assert.deepEqual(lines, ["第二版"]);
	});

	it("重载之后旧的那一代上下文被判定失效", async () => {
		const f = fixture();
		writeFileSync(join(f.directory, "demo.ts"), pluginSource("demo", "第一版"));
		await f.external.load();

		const first = lastApi();
		assert.ok(first !== undefined, "第一次装载应当把 api 留下来");

		await f.external.load();

		// 旧插件要是还能往里塞东西，「插件间只能经宿主服务通信」这条就落空了
		assert.throws(() => first.registerTool(coreTool("late_tool")), /上下文已经失效/);
		assert.throws(() => first.registerCommand({ name: "late", description: "x", async run() {} }), /上下文已经失效/);
		assert.equal(f.registry.get("late_tool"), undefined);
	});

	it("文件被删掉之后重载，它注册的东西跟着消失", async () => {
		const f = fixture();
		const file = join(f.directory, "demo.ts");
		writeFileSync(file, pluginSource("demo", "第一版"));
		await f.external.load();
		assert.ok(f.registry.get("demo_tool") !== undefined);

		unlinkSync(file);
		assert.deepEqual(await f.external.load(), []);

		assert.equal(f.registry.get("demo_tool"), undefined);
		assert.deepEqual(f.host.commands(), []);
	});

	it("文件改坏之后重载：这一版不生效，上一版也不会留着", async () => {
		const f = fixture();
		const file = join(f.directory, "demo.ts");
		writeFileSync(file, pluginSource("demo", "第一版"));
		await f.external.load();

		writeFileSync(file, "export default { name: 'demo', setup( { }\n");
		const failures = await f.external.load();

		assert.equal(failures.length, 1);
		assert.equal(failures[0].plugin, "demo");
		assert.match(failures[0].message, /装载失败/);
		// 旧版还留在注册表里的话，就成了「文件明明改坏了，旧的行为却还在」
		assert.equal(f.registry.get("demo_tool"), undefined);
	});

	it("一个插件写坏不影响别的插件", async () => {
		const f = fixture();
		writeFileSync(join(f.directory, "good.ts"), pluginSource("good", "好的"));
		writeFileSync(join(f.directory, "broken.ts"), "export default { name: 'broken', setup( { }\n");

		const failures = await f.external.load();

		assert.equal(failures.length, 1);
		assert.equal(failures[0].plugin, "broken");
		assert.equal(f.registry.get("good_tool")?.description, "好的");
	});

	it("重载只换外部插件，随包的插件不受影响", async () => {
		const f = fixture();
		// 随包分发的插件注册的工具：它不是「外部」的，重载不该让它消失
		f.registry.register(coreTool("bundled_tool"), "plugin");
		writeFileSync(join(f.directory, "demo.ts"), pluginSource("demo", "第一版"));

		await f.external.load();
		await f.external.load();

		assert.ok(f.registry.get("bundled_tool") !== undefined);
		assert.equal(f.registry.get("demo_tool")?.description, "第一版");
	});
});
