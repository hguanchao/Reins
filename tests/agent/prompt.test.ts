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

	it("注册了 todo 时生成具体的触发与收尾规则,未注册时不出现", () => {
		const withTodo = buildPromptSections({
			cwd: "/work",
			tools: [tool("todo", "")],
		}).rules;
		assert.ok(withTodo?.includes("three or more distinct steps"));
		assert.ok(withTodo?.includes("exactly one task in_progress"));
		assert.ok(withTodo?.includes("final call with every task completed or failed"));
		assert.ok(withTodo?.includes("do not restate the list"));

		const withoutTodo = buildPromptSections({
			cwd: "/work",
			tools: [tool("read", ""), tool("bash", "")],
		}).rules;
		assert.equal(withoutTodo?.includes("Use todo"), false);
	});

	it("Plan 模式整段替换 preamble，并说明提交计划的时机", () => {
		const sections = buildPromptSections({
			cwd: "/work",
			tools: [tool("read", ""), tool("present_plan", "")],
			planMode: true,
		});
		const preamble = sections["preamble"] ?? "";

		assert.ok(preamble.includes("You are in Plan mode"));
		assert.ok(preamble.includes("call present_plan"));
		assert.equal(preamble.includes("Do not stop at a plan"), false);
		assert.ok(sections["rules"]?.includes("Use present_plan once"));
		assert.ok(sections["tools"]?.includes("- present_plan"));
		assert.ok(sections["cwd"]?.includes("Shell commands are unavailable in Plan mode"));
	});

	it("Plan 模式的工具清单不会凭空出现 bash 或编辑规则", () => {
		const sections = buildPromptSections({
			cwd: "/work",
			tools: [tool("read", ""), tool("present_plan", "")],
			planMode: true,
		});
		assert.equal(sections["rules"]?.includes("Commands run in the workspace root"), false);
		assert.ok(sections["rules"]?.includes("Inspect files with read"));
	});

	it("撤销提醒作为独立分段，只在提供时出现", () => {
		const notice = "The working tree was rolled back; re-read files before acting.";
		const withNotice = buildPromptSections({ cwd: "/work", tools: [], undoNotice: notice });
		assert.equal(withNotice["checkpoint"], `Working tree update:\n${notice}`);
		assert.ok(renderSystemPrompt(withNotice).includes(notice));

		const without = buildPromptSections({ cwd: "/work", tools: [] });
		assert.equal(without["checkpoint"], undefined);
	});

	it("用户与项目规则作为独立分段,空列表不写", () => {
		const sections = buildPromptSections({
			cwd: "/work",
			tools: [],
			instructions: [
				{ label: "~/.reins/AGENTS.md", text: "global rules" },
				{ label: "AGENTS.md", text: "project rules" },
			],
		});
		const body = sections["instructions"] ?? "";

		assert.ok(body.includes("User and project instructions:"));
		assert.ok(body.includes("## ~/.reins/AGENTS.md\nglobal rules"));
		assert.ok(body.includes("## AGENTS.md\nproject rules"));
		assert.ok(body.indexOf("global rules") < body.indexOf("project rules"));
		assert.ok(body.includes("Project instructions are more specific"));

		assert.equal(
			buildPromptSections({ cwd: "/work", tools: [], instructions: [] })["instructions"],
			undefined,
		);
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

	it("技能只列名称、说明与 SKILL.md 路径，正文不进提示词", () => {
		const sections = buildPromptSections({
			cwd: "/work",
			tools: [],
			skills: [
				{ name: "writer", description: "把改动整理成文档", path: "/skills/writer/SKILL.md" },
				{ name: "bare", description: "", path: "/skills/bare/SKILL.md" },
			],
		});

		assert.ok(sections["skills"]?.includes("- writer: 把改动整理成文档 (/skills/writer/SKILL.md)"));
		// 没有说明时不留一个空冒号
		assert.ok(sections["skills"]?.includes("- bare (/skills/bare/SKILL.md)"));
		assert.ok(sections["skills"]?.includes("Read a skill's SKILL.md"));
	});

	it("没有技能时不写这一节", () => {
		assert.equal(buildPromptSections({ cwd: "/work", tools: [] })["skills"], undefined);
		assert.equal(buildPromptSections({ cwd: "/work", tools: [], skills: [] })["skills"], undefined);
	});

	it("技能排在工具之后、规则之前", () => {
		const text = renderSystemPrompt(
			buildPromptSections({
				cwd: "/work",
				tools: [tool("read", "Read a file.")],
				skills: [{ name: "writer", description: "写文档", path: "/skills/writer/SKILL.md" }],
			}),
		);

		const tools = text.indexOf("You can use these tools:");
		const skills = text.indexOf("Skills you can use:");
		const rules = text.indexOf("Tool rules:");
		assert.ok(tools >= 0 && skills > tools);
		assert.ok(rules > skills);
	});

	it("分段按固定顺序拼接", () => {
		const text = renderSystemPrompt({
			cwd: "cwd",
			rules: "rules",
			tools: "tools",
			instructions: "instructions",
			preamble: "preamble",
			extra: "extra",
		});

		assert.equal(text, "preamble\n\ntools\n\ninstructions\n\nrules\n\ncwd\n\nextra");
	});

	it("子代理使用自己的开场白并保留工具、工作根与规则", () => {
		const text = buildSubagentPrompt({
			cwd: "/work",
			tools: [tool("read", "Full read description", "Read a file")],
			instructions: [{ label: "AGENTS.md", text: "Use tabs." }],
		});

		assert.ok(text.includes("You are a subagent handling one assigned task."));
		assert.equal(text.includes("You are Reins"), false);
		assert.ok(text.includes("- read: Read a file"));
		assert.ok(text.includes("Workspace root: /work"));
		assert.ok(text.includes("## AGENTS.md\nUse tabs."));
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
