import type { ToolDeclaration } from "../tools/contract.ts";
import type { SessionToolDeclaration } from "../session/port.ts";

/**
 * 系统提示词的组装与渲染。
 *
 * 提示词由若干具名分段拼成，而不是一整块文本。这样它才能在会话里以增量的形式记录：改了
 * 哪一段就只记哪一段，请求前按固定顺序拼回完整提示词。分段还有一个用处——同一段规则只写
 * 一次，工具自己声明用法，这里只负责汇总。
 */

/** 渲染顺序。提示词的结构固定，顺序不随注册顺序变化，否则每次请求的缓存前缀都不一样。 */
export const SECTION_ORDER: readonly string[] = ["preamble", "tools", "rules", "cwd"];

const PREAMBLE = `You are a coding assistant working in a terminal. You can read and write files inside the workspace, run commands, and report results back to the user.

How to work:
- Look before you touch: read a file before changing it, and confirm anything uncertain with a command first.
- Do one thing at a time, and verify the result before moving on.
- When a command or test fails, do not work around it: read the whole error, work out the cause, then decide the next step.
- Never delete a test or skip a check just to make the suite pass.

How to communicate:
- Answer in English, short and direct; no pleasantries or filler.
- Give full paths when you mention a file.
- When you report, say what you did and how it turned out; if something is unfinished, say so.`;

const TOOLS_HEADING = "You can use these tools:";

/**
 * 子代理的交代。
 *
 * 与主对话最大的差别是「没有人可以问」：子代理只有一段任务描述，问一句就卡在那里，而派它
 * 干活的那一方看不到它的中间过程。所以这里要求它自己拿主意，并把判断与结论写进汇报。
 */
const SUBAGENT_PREAMBLE = `You are a subagent working on one assigned task.

How to work:
- Do that task only; do not touch anything unrelated along the way.
- Nobody can answer your questions: decide for yourself where things are uncertain, or take the most conservative option the current state allows, and record that judgement in your report.
- Look before you touch: read a file before changing it, and confirm anything uncertain with a command first.
- Never delete a test or skip a check just to make the suite pass.

How to report:
- Write one passage in English covering what you did, how it turned out, and what is still open. No pleasantries.
- Whoever sent you cannot see your intermediate command output or file contents, so put the key paths and conclusions into that passage.
- If it is unfinished, say it is unfinished; do not report an attempt as a success.`;

const RULES: readonly string[] = [
	"To change an existing file use edit, not write: write discards the parts you never read.",
	"edit's oldText must match the file exactly and appear exactly once; read the file first when unsure.",
	"For large files, read in ranges with offset and limit instead of trying to read everything at once.",
	"Command output may be truncated, and the end will say so; narrow the command when you need the full content.",
];

export interface PromptInput {
	readonly cwd: string;
	readonly tools: readonly ToolDeclaration[];
}

/** 生成当前应当生效的分段。只有内容变化时才需要写进会话。 */
export function buildPromptSections(input: PromptInput): Record<string, string> {
	const sections: Record<string, string> = {
		preamble: PREAMBLE,
		rules: RULES.map((rule) => `- ${rule}`).join("\n"),
		cwd: `Workspace root: ${input.cwd}`,
	};
	if (input.tools.length > 0) {
		sections["tools"] = [
			TOOLS_HEADING,
			...input.tools.map((tool) => `- ${tool.name}: ${tool.description}`),
		].join("\n");
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
