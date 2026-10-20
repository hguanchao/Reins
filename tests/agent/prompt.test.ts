import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildPromptSections,
	buildSubagentPrompt,
	renderSystemPrompt,
	toSessionTools,
} from "../../src/agent/prompt.ts";
import type { ToolDeclaration } from "../../src/tools/contract.ts";

const PARAMETERS = { type: "object", properties: {} } as const;

function tool(name: string, description: string, summary?: string): ToolDeclaration {
	return {
		name,
		description,
		...(summary === undefined ? {} : { summary }),
		parameters: PARAMETERS,
	};
}

describe("系统提示词", () => {
	it("工具清单优先使用短摘要，没有摘要时退回完整描述", () => {
		const sections = buildPromptSections({
			cwd: "/work",
			tools: [tool("read", "Full read description", "Short read"), tool("ls", "List a directory.")],
		});

		assert.ok(sections["tools"]?.includes("- read: Short read"));
		assert.equal(sections["tools"]?.includes("Full read description"), false);
		assert.ok(sections["tools"]?.includes("- ls: List a directory."));
	});

	it("规则按当前注册的工具生成", () => {
		const withSearch = buildPromptSections({
			cwd: "/work",
			tools: [
				tool("read", ""),
				tool("edit", ""),
				tool("bash", ""),
				tool("grep", ""),
				tool("find", ""),
				tool("ls", ""),
			],
		}).rules;
		assert.ok(withSearch?.includes("do not prefix commands with cd"));
		assert.ok(withSearch?.includes("Use grep, find, ls instead of their shell equivalents"));

		const withoutSearch = buildPromptSections({
			cwd: "/work",
			tools: [tool("read", ""), tool("edit", ""), tool("bash", "")],
		}).rules;
		assert.equal(withoutSearch?.includes("instead of their shell equivalents"), false);
	});

	it("没有工具时不生成使用规则", () => {
		const sections = buildPromptSections({ cwd: "/work", tools: [] });

		assert.equal(sections["rules"], undefined);
		assert.equal(sections["tools"], undefined);
	});

	it("工作根分段说明相对路径与命令以它为起点", () => {
		const sections = buildPromptSections({ cwd: "E:/work", tools: [] });

		assert.equal(
			sections["cwd"],
			"Workspace root: E:/work\nRelative paths and shell commands resolve from this directory.",
		);
	});

	it("分段按固定顺序拼接", () => {
		const text = renderSystemPrompt({
			cwd: "cwd",
			rules: "rules",
			tools: "tools",
			preamble: "preamble",
			extra: "extra",
		});

		assert.equal(text, "preamble\n\ntools\n\nrules\n\ncwd\n\nextra");
	});

	it("子代理使用自己的开场白并保留工具与工作根", () => {
		const text = buildSubagentPrompt({
			cwd: "/work",
			tools: [tool("read", "Full read description", "Read a file")],
		});

		assert.ok(text.includes("You are a subagent handling one assigned task."));
		assert.equal(text.includes("You are Reins"), false);
		assert.ok(text.includes("- read: Read a file"));
		assert.ok(text.includes("Workspace root: /work"));
	});

	it("会话声明只记录完整描述与参数，不记录提示词摘要", () => {
		const [declared] = toSessionTools([tool("read", "Full read description", "Short read")]);

		assert.deepEqual(declared, {
			name: "read",
			description: "Full read description",
			parameters: PARAMETERS,
		});
	});
});
