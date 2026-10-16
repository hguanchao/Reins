import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { TurnDriver } from "../../../src/agent/driver.ts";
import type { AgentEventListener } from "../../../src/agent/events.ts";
import type { Config } from "../../../src/config/config-file.ts";
import type { ModelEntry, ProviderEntry } from "../../../src/config/models-file.ts";
import { PermissionGate, PermissionPolicy, type Confirmer } from "../../../src/permission/policy.ts";
import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import { JsonlSessionStore } from "../../../src/plugins/session-plugin/jsonl-store.ts";
import { createSandbox } from "../../../src/sandbox/setup.ts";
import { Session } from "../../../src/session/session.ts";
import { createCoreTools } from "../../../src/tools/builtin/index.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { ResultSpiller } from "../../../src/tools/spill.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";
import { MemoryTerminal, screenOf } from "../../tui/memory-terminal.ts";
import { ScriptedClient, textResult, toolCallResult } from "../../agent/scripted-client.ts";
import { makeRuntime } from "./helpers.ts";

/**
 * 界面与回合驱动的接合处。
 *
 * 这一段是两块独立测试都盖不到的地方：审批确认从工具管线里发出，落到界面的方框上，按键再从
 * 方框回到管线。所以这里用真的驱动、真的工具、真的会话，只把模型换成按脚本应答的客户端。
 */

const work = mkdtempSync(join(tmpdir(), "reins-ui-work-"));
const sessions = mkdtempSync(join(tmpdir(), "reins-ui-sessions-"));

after(() => {
	rmSync(work, { recursive: true, force: true });
	rmSync(sessions, { recursive: true, force: true });
});

const provider: ProviderEntry = {
	id: "demo",
	name: "示例",
	baseUrl: "http://127.0.0.1:1",
	api: "openai-completions",
	apiKey: "k",
	headers: {},
	models: [],
};

const model: ModelEntry = {
	id: "m1",
	name: "示例模型",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	thinkingLevelMap: {},
	contextWindow: undefined,
	maxTokens: undefined,
	headers: {},
};

const config: Config = {
	provider: "demo",
	model: "m1",
	reasoningEffort: "off",
	contextWindow: undefined,
	maxTokens: undefined,
	maxRetries: 0,
	httpProxy: undefined,
	compactModel: undefined,
	reviewModel: undefined,
	approval: "ask",
	sandbox: "off",
	maxTurns: undefined,
	spillThreshold: 0,
	ui: { notify: "auto" },
	mcpServers: [],
	plugins: { disabled: [], trusted: [] },
};

interface Harness {
	readonly terminal: MemoryTerminal;
	readonly session: Session;
	/** 屏幕上出现过的所有文字，含已经滚出可视区的部分 */
	readonly seen: () => string[];
	readonly confirmations: string[];
	readonly finish: () => Promise<void>;
}

let counter = 0;

async function start(client: ScriptedClient): Promise<Harness> {
	counter += 1;
	const terminal = new MemoryTerminal({ rows: 14, cols: 60 });
	const frontend = new TerminalFrontend({ terminal, env: {} });

	const policy = new PermissionPolicy(config.approval);
	let confirmer: Confirmer | undefined;
	const confirmations: string[] = [];
	const gate = new PermissionGate({
		policy,
		confirmer: async (question, detail) => {
			confirmations.push(question);
			return confirmer === undefined ? false : confirmer(question, detail);
		},
	});

	const registry = new ToolRegistry(new ResultSpiller(0, join(work, "spill")), gate);
	for (const tool of createCoreTools()) registry.register(tool, "core");

	const setup = createSandbox(config.sandbox, work, []);
	const file = join(sessions, `s${counter}.jsonl`);
	const id = `s${counter}`;
	const session = new Session({
		id,
		cwd: work,
		file,
		writer: new JsonlSessionStore().create({ id, cwd: work, file }),
	});
	const workspace = new WorkspaceBoundary(work);

	const fake = makeRuntime({ session: { id: session.id, path: session.path } });
	const runtime = {
		...fake.runtime,
		createDriver: (onEvent: AgentEventListener): TurnDriver =>
			new TurnDriver({
				provider,
				model,
				config,
				client,
				tools: registry,
				session,
				workspace,
				sandbox: setup.sandbox,
				onEvent,
			}),
		setConfirmer: (value: Confirmer | undefined): void => {
			confirmer = value;
		},
	};

	const done = frontend.run(runtime);
	await settle();

	return {
		terminal,
		session,
		confirmations,
		seen: () => [...screenOf(terminal).scrolled(), ...screenOf(terminal).visible()],
		finish: async () => {
			terminal.feedInput("\x15/exit\r");
			await done;
			await session.close();
			await settle();
		},
	};
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

/** 等到界面上出现某段文字为止；超时就把屏幕内容一起报出来，免得只看一句「失败了」。 */
async function waitForText(harness: Harness, text: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (harness.seen().some((line) => line.includes(text))) return;
		await settle();
	}
	throw new Error(`等不到「${text}」，屏幕上是：\n${harness.seen().join("\n")}`);
}

function messages(harness: Harness): readonly unknown[] {
	return harness.session.entries().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

describe("界面与驱动的接合", () => {
	it("工具调用要经过审批：同意之后才真的执行", async () => {
		const target = join(work, "批准之后.txt");
		const client = new ScriptedClient([
			toolCallResult({ id: "c1", name: "write", arguments: { path: target, content: "写好" } }),
			textResult("写完了"),
		]);
		const harness = await start(client);

		harness.terminal.feedInput("写一个文件\r");
		await waitForText(harness, "是否允许执行 write");
		assert.equal(existsSync(target), false);

		harness.terminal.feedInput("y");
		await waitForText(harness, "写完了");

		assert.equal(readFileSync(target, "utf8"), "写好");
		assert.ok(harness.seen().some((line) => line.includes("✓ write")));

		await harness.finish();
	});

	it("拒绝之后工具不会执行，模型收到的是拒绝的理由", async () => {
		const target = join(work, "没有批准.txt");
		const client = new ScriptedClient([
			toolCallResult({ id: "c1", name: "write", arguments: { path: target, content: "不该写" } }),
			textResult("那我就不写了"),
		]);
		const harness = await start(client);

		harness.terminal.feedInput("写一个文件\r");
		await waitForText(harness, "是否允许执行 write");

		harness.terminal.feedInput("n");
		await waitForText(harness, "那我就不写了");

		assert.equal(existsSync(target), false);
		assert.ok(harness.seen().some((line) => line.includes("✗ write")));
		// 拒绝的理由进了会话，模型下一轮看得到
		assert.ok(JSON.stringify(messages(harness)).includes("使用者没有同意"));

		await harness.finish();
	});

	it("工具的输出回到模型，也显示在界面上", async () => {
		mkdirSync(work, { recursive: true });
		const client = new ScriptedClient([
			toolCallResult({ id: "c1", name: "bash", arguments: { command: "echo 你好" } }),
			textResult("跑完了"),
		]);
		const harness = await start(client);

		harness.terminal.feedInput("跑个命令\r");
		await waitForText(harness, "是否允许执行 bash");
		harness.terminal.feedInput("y");
		await waitForText(harness, "跑完了");

		assert.ok(JSON.stringify(messages(harness)).includes("你好"));

		await harness.finish();
	});

	it("会话文件里留下了这一轮的全部记录", async () => {
		const client = new ScriptedClient([textResult("就一句话")]);
		const harness = await start(client);

		harness.terminal.feedInput("说一句\r");
		await waitForText(harness, "就一句话");
		await harness.finish();

		const written = readFileSync(harness.session.path ?? "", "utf8");
		assert.ok(written.includes("说一句"));
		assert.ok(written.includes("就一句话"));
	});
});
