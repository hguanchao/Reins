import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { TurnDriver } from "../../src/agent/driver.ts";
import { renderSystemPrompt } from "../../src/agent/prompt.ts";
import { parseConfig } from "../../src/config/config-file.ts";
import { parseProviders } from "../../src/config/providers-file.ts";
import { JsonlSessionStore, parseSessionText } from "../../src/plugins/session-plugin/jsonl-store.ts";
import { foldEntries } from "../../src/session/fold.ts";
import { Session } from "../../src/session/session.ts";
import { Sandbox } from "../../src/sandbox/policy.ts";
import { createCoreTools } from "../../src/tools/builtin/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import { WorkspaceBoundary } from "../../src/workspace/boundary.ts";
import { allowAllGate, createTestWorkspace, type TestWorkspace } from "../tools/helpers.ts";
import { ScriptedClient, textResult, toolCallResult } from "./scripted-client.ts";

/**
 * 会话重放。
 *
 * 这是整套设计里最容易做错也最要紧的一条约定：下一次请求要用的东西全部来自会话记录，
 * 没有任何藏在内存里的补充。所以把文件从头读一遍、折叠出状态，必须得到与当时实际发出去
 * 的请求完全一致的结果。
 */

const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
});

describe("会话重放", () => {
	it("从文件折叠出的状态能还原出当时发出的请求", async () => {
		workspace.writeFile("target.txt", "文件内容");
		const file = join(workspace.root, "session.jsonl");

		const config = parseConfig(
			'provider = "p"\nmodel = "test-model"\nreasoning_effort = "high"\nspill_threshold = 0\n',
			"config.toml",
		);
		const providersConfig = parseProviders(
			JSON.stringify({
				providers: {
					p: {
						baseUrl: "https://x",
						api: "openai-completions",
						models: [{ id: "test-model", reasoning: true, maxTokens: 4096 }],
					},
				},
			}),
			"providers.json",
		);
		const provider = providersConfig.providers[0];
		const model = provider.models[0];

		const registry = new ToolRegistry(new ResultSpiller(0, workspace.root), allowAllGate);
		for (const tool of createCoreTools()) registry.register(tool, "core");

		const client = new ScriptedClient([
			toolCallResult({ id: "call_1", name: "read", arguments: { path: "target.txt" } }),
			textResult("读到了文件内容"),
		]);

		const store = new JsonlSessionStore();
		const session = new Session({
			id: "replay",
			cwd: workspace.root,
			file,
			writer: store.create({ id: "replay", cwd: workspace.root, file }),
		});
		try {
			const driver = new TurnDriver({
				provider,
				model,
				config,
				client,
				tools: registry,
				session,
				workspace: new WorkspaceBoundary(workspace.root),
				sandbox: new Sandbox({ mode: "off", root: workspace.root }, undefined),
				onEvent: () => undefined,
			});
			await driver.run("看看 target.txt", new AbortController().signal);
		} finally {
			await session.close();
		}

		// 会话文件本身：首行是头，之后每条都串在前一条上
		const parsed = parseSessionText(readFileSync(file, "utf8"));
		assert.equal(parsed.skippedLines, 0);
		assert.equal(parsed.header?.version, 1);
		assert.equal(parsed.header?.cwd, workspace.root);
		assert.deepEqual(
			parsed.entries.map((entry) => entry.type),
			["system", "model_change", "effort_change", "message", "message", "message", "usage", "message"],
		);
		// 用量记的是这一次请求的规模，它不进上下文，只用于统计
		const usage = parsed.entries[6];
		assert.equal(usage.type === "usage" ? usage.kind : "", "turn");
		assert.equal(usage.type === "usage" ? usage.usage.total : 0, 15);
		assert.equal(parsed.entries[0].parentId, null);
		for (let index = 1; index < parsed.entries.length; index += 1) {
			assert.equal(parsed.entries[index].parentId, parsed.entries[index - 1].id);
		}
		assert.equal(new Set(parsed.entries.map((entry) => entry.id)).size, parsed.entries.length);

		// 第一次请求前的四条记录，折叠出来就是当时发出去的请求
		assert.equal(client.requests.length, 2);
		const beforeFirst = foldEntries(parsed.entries.slice(0, 4));
		assert.equal(client.requests[0].system, renderSystemPrompt(beforeFirst.sections));
		assert.deepEqual(client.requests[0].messages, beforeFirst.messages);
		assert.deepEqual(
			client.requests[0].tools,
			beforeFirst.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		);
		assert.equal(client.requests[0].effort, "high");
		assert.equal(client.requests[0].maxTokens, 4096);

		// 第二次请求前多了助手消息与工具结果，折叠出来同样对得上
		const beforeSecond = foldEntries(parsed.entries.slice(0, 6));
		assert.equal(client.requests[1].system, renderSystemPrompt(beforeSecond.sections));
		assert.deepEqual(client.requests[1].messages, beforeSecond.messages);
		assert.deepEqual(client.requests[1].messages[2], {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: "文件内容",
			isError: false,
		});

		// 提示词与工具声明只记录增量：两次折叠出的分段与工具完全一致
		assert.deepEqual(beforeFirst.sections, beforeSecond.sections);
		assert.deepEqual(beforeFirst.tools, beforeSecond.tools);
	});
});
