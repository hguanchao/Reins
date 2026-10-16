import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import type { McpServerConfig } from "../../../src/config/config-file.ts";
import { PermissionGate, PermissionPolicy } from "../../../src/permission/policy.ts";
import { PluginHost } from "../../../src/plugins/host.ts";
import { createMcpPlugin } from "../../../src/plugins/mcp-plugin/index.ts";
import { Sandbox } from "../../../src/sandbox/policy.ts";
import { ToolRegistry, type ToolRunContext } from "../../../src/tools/registry.ts";
import { ResultSpiller } from "../../../src/tools/spill.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";
import { allowAllGate } from "../../tools/helpers.ts";

/**
 * MCP 插件。
 *
 * 要钉住的是两件事：连不上不能挡启动（原因进 /mcps 清单），以及远端工具与核心工具受完全
 * 相同的约束——它们注册进同一个注册表、走同一条管线，审批一样不少。后者是插件体系正确性
 * 的判据：插件能做的只是「告诉宿主远端有什么」，管不到判定。
 */

const fixture = fileURLToPath(new URL("./fixture-server.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "reins-mcp-"));

after(() => {
	rmSync(directory, { recursive: true, force: true });
});

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		name: "demo",
		type: "stdio",
		command: process.execPath,
		args: [fixture],
		url: undefined,
		headers: {},
		callTimeoutMs: undefined,
		disabled: false,
		...overrides,
	};
}

interface Fixture {
	readonly registry: ToolRegistry;
	readonly host: PluginHost;
	readonly failures: readonly { readonly plugin: string; readonly message: string }[];
}

async function start(servers: readonly McpServerConfig[]): Promise<Fixture> {
	const policy = new PermissionPolicy("yolo");
	const registry = new ToolRegistry(new ResultSpiller(0, directory), allowAllGate);
	const host = new PluginHost(registry, policy);
	const failures = await host.load([
		// 子进程的工作目录用当前目录：临时目录是给落盘用的，让子进程占住它会在 Windows 上
		// 让清理失败
		createMcpPlugin({ cwd: process.cwd(), version: "0.0.0", servers }),
	]);
	return { registry, host, failures };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`等不到${what}`);
}

async function mcps(host: PluginHost): Promise<readonly string[]> {
	const lines: string[] = [];
	await host.runCommand("mcps", "", { cwd: directory, print: (line) => lines.push(line) });
	return lines;
}

function context(): ToolRunContext {
	return {
		workspace: new WorkspaceBoundary(directory),
		sandbox: new Sandbox({ mode: "off", root: directory }, undefined),
		session: { id: "s", path: null },
		signal: new AbortController().signal,
		onUpdate: () => undefined,
	};
}

describe("MCP 插件", () => {
	it("连上之后把远端工具注册进来，名字带 server 前缀", async () => {
		const { registry, failures } = await start([serverConfig()]);
		await waitFor(() => registry.get("demo_echo") !== undefined, "远端工具");

		assert.deepEqual(failures, []);
		// 两个 server 各有一个 echo 是常事，前缀让它们不会撞在一起
		assert.match(registry.get("demo_echo")?.description ?? "", /^\[MCP demo\]/);
		assert.ok(registry.get("demo_fail") !== undefined);
		// 来源标成插件：它不是核心工具，插件被禁用时它就该消失
		assert.deepEqual(
			registry.describe().filter((item) => item.name.startsWith("demo_")),
			[
				{ name: "demo_echo", source: "plugin" },
				{ name: "demo_fail", source: "plugin" },
			],
		);
	});

	it("调用远端工具，文本与非文本内容都交回模型", async () => {
		const { registry } = await start([serverConfig()]);
		await waitFor(() => registry.get("demo_echo") !== undefined, "远端工具");

		const outcome = await registry.call({ callId: "c1", name: "demo_echo", args: { text: "你好" } }, context());

		assert.equal(outcome.isError, false);
		assert.equal(outcome.content, "回声：你好\n\n[image 内容，本程序不显示]");
	});

	it("远端报告失败时结果也是失败", async () => {
		const { registry } = await start([serverConfig()]);
		await waitFor(() => registry.get("demo_fail") !== undefined, "远端工具");

		const outcome = await registry.call({ callId: "c1", name: "demo_fail", args: {} }, context());

		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /远端说做不了/);
	});

	it("远端工具与核心工具受同一套审批约束：没人可问时按拒绝处理", async () => {
		const policy = new PermissionPolicy("ask");
		const registry = new ToolRegistry(
			new ResultSpiller(0, directory),
			new PermissionGate({ policy }),
		);
		const host = new PluginHost(registry, policy);
		await host.load([createMcpPlugin({ cwd: process.cwd(), version: "0.0.0", servers: [serverConfig()] })]);
		await waitFor(() => registry.get("demo_echo") !== undefined, "远端工具");

		const outcome = await registry.call({ callId: "c1", name: "demo_echo", args: { text: "你好" } }, context());

		// 它照样得穿过审批链，而不是因为来自插件就直通
		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /无法征求同意/);
	});

	it("插件加的审批规则对远端工具一样有效", async () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule({
			decision: "deny",
			reason: "这个 server 不许用",
			matches: (tool) => tool.startsWith("demo_"),
		});
		const registry = new ToolRegistry(
			new ResultSpiller(0, directory),
			new PermissionGate({ policy }),
		);
		const host = new PluginHost(registry, policy);
		await host.load([createMcpPlugin({ cwd: process.cwd(), version: "0.0.0", servers: [serverConfig()] })]);
		await waitFor(() => registry.get("demo_echo") !== undefined, "远端工具");

		const outcome = await registry.call({ callId: "c1", name: "demo_echo", args: { text: "你好" } }, context());

		assert.equal(outcome.isError, true);
		assert.match(outcome.content, /这个 server 不许用/);
	});

	it("/mcps 列出连接状态与工具清单", async () => {
		const { registry, host } = await start([serverConfig()]);
		await waitFor(() => registry.get("demo_echo") !== undefined, "远端工具");

		const lines = await mcps(host);

		assert.equal(lines.length, 1);
		assert.match(lines[0], /^demo\s+已连接/);
		assert.match(lines[0], /2 个工具：echo、fail/);
	});

	it("disabled = true 的 server 不连接，只出现在清单里", async () => {
		const { registry, host } = await start([serverConfig({ name: "off", disabled: true })]);
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(registry.get("off_echo"), undefined);
		assert.match((await mcps(host))[0], /已禁用/);
	});

	it("连不上不挡启动，原因进 /mcps 清单", async () => {
		const { registry, host, failures } = await start([serverConfig({ command: "reins-不存在的命令" })]);

		// 装载本身是成功的：远端连不上不该让整个程序起不来
		assert.deepEqual(failures, []);
		assert.equal(registry.get("demo_echo"), undefined);

		// 连接在后台进行，等它把失败原因记下来
		let line = "";
		for (let attempt = 0; attempt < 200 && !line.includes("连不上"); attempt += 1) {
			line = (await mcps(host))[0] ?? "";
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		assert.match(line, /连不上/);
		assert.match(line, /无法启动/);
	});

	it("没有配置 server 时清单说明怎么配", async () => {
		const { host } = await start([]);
		assert.match((await mcps(host))[0], /没有配置 MCP server/);
	});
});
