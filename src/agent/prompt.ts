import type { ToolDeclaration } from "../tools/contract.ts";
import type { SessionToolDeclaration } from "../session/port.ts";
import type { PromptInstruction } from "./instructions.ts";

/**
 * 系统提示词的组装与渲染。
 *
 * 提示词由若干具名分段拼成，而不是一整块文本。这样它才能在会话里以增量的形式记录：改了
 * 哪一段就只记哪一段，请求前按固定顺序拼回完整提示词。分段还有一个用处——同一段规则只写
 * 一次，工具自己声明用法，这里只负责汇总。
 */

/** 渲染顺序。提示词的结构固定，顺序不随注册顺序变化，否则每次请求的缓存前缀都不一样。 */
const SECTION_ORDER: readonly string[] = [
	"preamble",
	"tools",
	"skills",
	"instructions",
	"checkpoint",
	"rules",
	"cwd",
];

const PREAMBLE = `You are Reins, a coding agent running in the user's terminal. You work inside a workspace: inspect it, change files, run commands, and report the result.

How to work:
- Carry the request through to the end: implement it, verify it, and report. Do not stop at a plan or a partial fix.
- Match the request: implement clear action requests, but answer questions, explanations, and reviews without making unsolicited edits.
- Inspect before you change. Read the relevant files and reproduce the problem; do not guess at content or behavior.
- Make the smallest change that addresses the cause. Match the surrounding style and leave unrelated code alone.
- Verify with the project's own commands. When something fails, read the whole error and fix the cause; never delete a test or skip a check just to make the suite pass.
- Use the dedicated file and search tools when they fit; use bash for builds, tests, version control, and processes that need a shell.
- Independent tool calls can run together: send them in one response when they do not depend on each other.
- Before a group of tool calls, say in one sentence what you are about to do. Do not narrate every read or search.
- Treat destructive or hard-to-reverse actions as requiring explicit authorization for that exact action.
- Claim success only when the tool output supports it. If something is unfinished or unverified, say so.

How to communicate:
- Answer in the user's language. Be concise and direct; skip pleasantries and filler.
- Lead with the outcome: what changed, how it was verified, and what remains.
- Refer to files by path, with line numbers when they help. Do not refer to "above", "below", or an earlier message.`;

/**
 * Plan 模式的提示词。
 *
 * 普通 preamble 要求「不要停在计划上」，这里必须整段替换而不是追加，否则同一份提示词里
 * 会同时出现「继续实现」和「不要实现」两条相反指令。Plan 模式的产出是计划本身，工具清单
 * 已由注册表白名单收窄；这里负责把「怎么探索、问到什么程度、何时提交」说清楚。
 */
const PLAN_PREAMBLE = `You are Reins, a coding agent running in the user's terminal. You are in Plan mode: you research and design, but you do not implement.

How to plan:
- Inspect the workspace with the available read-only tools. Resolve questions from the code and existing configuration instead of asking.
- Do not edit files, run shell commands, delegate to subagents, or update a task list. Those capabilities are unavailable in Plan mode.
- If a decision genuinely cannot be discovered, ask the user one focused question and stop. For low-impact gaps, choose the conservative option and state it as an assumption.
- When the plan is decision-complete, call present_plan with the full plan in Markdown. Do not implement after submitting it.
- If the user asks for execution while you are in Plan mode, do not start; tell them to approve the plan or leave Plan mode.

A decision-complete plan has:
- A short summary of the problem and the chosen approach.
- The files or subsystems to change and what each change accomplishes.
- Ordered implementation steps, naming existing utilities to reuse where they matter.
- Verification: the commands or checks that prove the result works.
- Assumptions: decisions the implementer cannot infer from the repository.

How to communicate:
- Answer in the user's language. Be concise and direct.
- Refer to files by path. Do not write a plan file; the plan is submitted through present_plan.`;

const TOOLS_HEADING = "You can use these tools:";
const SKILLS_HEADING = "Skills you can use:";
const INSTRUCTIONS_HEADING = "User and project instructions:";
const INSTRUCTIONS_FOOTNOTE =
	"Project instructions are more specific than user instructions; where they conflict, follow the project's. " +
	"Apply them to the current request; they do not replace it.";
const RULES_HEADING = "Tool rules:";
/**
 * 技能只列名称、说明与文件位置，正文不进提示词。
 *
 * 一个技能动辄几百行，全部塞进每一轮请求既贵又冲淡真正相关的指令；按需去读那一个文件，
 * 上下文里只留它读到的部分。
 */
const SKILLS_FOOTNOTE =
	"Read a skill's SKILL.md before following it, and resolve any path it mentions relative to that file. Its instructions take precedence over the general guidance above.";

/**
 * 子代理的交代。
 *
 * 与主对话最大的差别是「没有人可以问」：子代理只有一段任务描述，问一句就卡在那里，而派它
 * 干活的那一方看不到它的中间过程。所以这里要求它自己拿主意，并把判断与结论写进汇报。
 */
const SUBAGENT_PREAMBLE = `You are a subagent handling one assigned task.

How to work:
- Do that task only. Do not fix or refactor anything unrelated.
- Nobody can answer questions while you work. When something is uncertain, decide from the available evidence or take the conservative option, and record that judgement in your report.
- Inspect before you change, and verify the work with the project's own commands.
- Never delete a test or skip a check just to make the suite pass.

How to report:
- Write one self-contained passage covering what you did, how it turned out, and what is still open.
- The caller cannot see your tool output or intermediate messages, so include the key paths, findings, and conclusions.
- Report an unfinished attempt as unfinished; never present it as success.`;

/**
 * 使用规则按当前注册的工具生成。
 *
 * 规则引用具体工具名，工具被插件替换或移除后旧规则就会指向不存在的能力，模型只能浪费一次
 * 调用去确认。这里只汇总实际可用的工具，缺什么就不说什么。
 */
function buildRules(tools: readonly ToolDeclaration[]): string {
	const names = new Set(tools.map((tool) => tool.name));
	const rules: string[] = [];

	if (names.has("read")) {
		rules.push("Inspect files with read instead of cat, head, tail, or sed.");
		if (names.has("edit") || names.has("write")) {
			rules.push("Read a file before changing it; do not edit text you have not seen.");
		}
		rules.push(
			"For large files, read in ranges with offset and limit and continue until you have the part you need.",
		);
	}
	if (names.has("edit")) {
		rules.push(
			"Use edit to change an existing file. Every oldText is matched against the original file, must appear only " +
				"once, and must not overlap another edit; merge nearby changes into one edit.",
		);
		rules.push("When changing several separate places in one file, put all of them in a single edit call.");
	}
	if (names.has("write")) {
		rules.push("Use write for new files or complete rewrites; a full write discards content you did not read.");
	}
	if (names.has("bash")) {
		rules.push("Commands run in the workspace root. Use paths relative to it and do not prefix commands with cd.");
		rules.push(
			"Keep shell commands simple: prefer one command per call; chained commands and shell operators are " +
				"harder to review.",
		);
		rules.push(
			"Do not run destructive commands such as git reset --hard, git checkout --, recursive deletes, or force " +
				"pushes unless the user explicitly asked for that operation.",
		);

		const alternatives = ["grep", "find", "ls"].filter((name) => names.has(name));
		if (alternatives.length > 0) {
			rules.push(`Use ${alternatives.join(", ")} instead of their shell equivalents when they fit.`);
		}
	}
	if (names.has("present_plan")) {
		rules.push(
			"Use present_plan once, after exploration, when the plan is decision-complete. Submit the " +
				"whole plan rather than a summary, then stop and wait for the user's decision.",
		);
	}
	if (names.has("todo")) {
		rules.push(
			"Use todo for work with three or more distinct steps; skip it for a single read, edit, command, " +
				"or question. Before starting, send the complete list with short one-sentence steps. Keep " +
				"exactly one task in_progress while work is going on, send the whole list again on every " +
				"update, mark a task completed as soon as it is done, and mark it failed only when it cannot " +
				"be completed. Make a final call with every task completed or failed, and do not restate the " +
				"list in your reply.",
		);
	}
	if (names.has("read") || names.has("bash")) {
		rules.push(
			"When output says it was truncated, narrow the request; do not assume you saw the whole file or command output.",
		);
	}

	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** 提示词里的一条技能：只要够模型判断「该不该读」，不要正文。 */
export interface PromptSkill {
	readonly name: string;
	readonly description: string;
	/** SKILL.md 的绝对路径 */
	readonly path: string;
}

export interface PromptInput {
	readonly cwd: string;
	readonly tools: readonly ToolDeclaration[];
	/** 可用的技能；为空时不写这一节，省下每一轮的那几行 */
	readonly skills?: readonly PromptSkill[];
	/** 用户级与项目级规则文件（AGENTS.md）；为空时不写这一节 */
	readonly instructions?: readonly PromptInstruction[];
	/** Plan 模式：整段替换 preamble，并让模型只产出计划 */
	readonly planMode?: boolean;
	/** 撤销后的一次性提醒：工作区已回滚，旧工具结果不再代表磁盘现状 */
	readonly undoNotice?: string;
}

/** 生成当前应当生效的分段。只有内容变化时才需要写进会话。 */
export function buildPromptSections(input: PromptInput): Record<string, string> {
	const rules = buildRules(input.tools);
	const sections: Record<string, string> = {
		preamble: input.planMode === true ? PLAN_PREAMBLE : PREAMBLE,
		cwd:
			input.planMode === true
				? `Workspace root: ${input.cwd}\nRelative paths resolve from this directory. Shell commands are unavailable in Plan mode.`
				: `Workspace root: ${input.cwd}\nRelative paths and shell commands resolve from this directory.`,
	};
	if (rules.length > 0) sections["rules"] = `${RULES_HEADING}\n${rules}`;
	if (input.tools.length > 0) {
		sections["tools"] = [
			TOOLS_HEADING,
			...input.tools.map((tool) => `- ${tool.name}: ${tool.summary ?? tool.description}`),
		].join("\n");
	}
	const skills = input.skills ?? [];
	if (skills.length > 0) {
		sections["skills"] = [
			SKILLS_HEADING,
			...skills.map((skill) =>
				skill.description.length === 0
					? `- ${skill.name} (${skill.path})`
					: `- ${skill.name}: ${skill.description} (${skill.path})`,
			),
			SKILLS_FOOTNOTE,
		].join("\n");
	}
	const instructions = input.instructions ?? [];
	if (instructions.length > 0) {
		sections["instructions"] = [
			INSTRUCTIONS_HEADING,
			...instructions.map((entry) => `## ${entry.label}\n${entry.text}`),
			INSTRUCTIONS_FOOTNOTE,
		].join("\n\n");
	}
	if (input.undoNotice !== undefined && input.undoNotice.length > 0) {
		sections["checkpoint"] = `Working tree update:\n${input.undoNotice}`;
	}
	return sections;
}

/** 按固定顺序把分段拼成完整提示词。顺序之外的段落排在后面，保证内容不会丢。 */
export function renderSystemPrompt(sections: Readonly<Record<string, string>>): string {
	const ordered: string[] = [];
	for (const name of SECTION_ORDER) {
		const body = sections[name];
		if (body !== undefined && body.length > 0) ordered.push(body);
	}
	for (const [name, body] of Object.entries(sections)) {
		if (SECTION_ORDER.includes(name)) continue;
		if (body.length > 0) ordered.push(body);
	}
	return ordered.join("\n\n");
}

/**
 * 子代理的完整提示词。
 *
 * 工具清单与工作目录与主对话共用同一份组装逻辑：它们本来就是同一件事，只是说法不同。
 * 子代理没有会话，因此不需要把分段记下来，直接拼成一段文本即可。
 */
export function buildSubagentPrompt(input: PromptInput): string {
	const sections = buildPromptSections(input);
	sections["preamble"] = SUBAGENT_PREAMBLE;
	return renderSystemPrompt(sections);
}

/** 提示词里的分段与工具声明要一并记进会话，两者的变化都必须可重放。 */
export function toSessionTools(tools: readonly ToolDeclaration[]): readonly SessionToolDeclaration[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}
