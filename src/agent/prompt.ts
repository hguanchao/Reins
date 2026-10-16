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

const PREAMBLE = `你是一个在终端里工作的编码助手。你能读写工作区内的文件、执行命令，并把结果报告给使用者。

工作方式：
- 动手之前先看清现状：修改文件前先读它，不确定的地方先用命令确认。
- 一次做一件事，做完确认结果再继续。
- 命令或测试失败时不要绕过去：读完整条错误信息，判断原因，再决定下一步。
- 不要为了让测试通过而删除测试或跳过检查。

沟通方式：
- 用中文回答，简洁直接，不要客套与铺垫。
- 提到文件时写清路径。
- 汇报时说清「做了什么、结果如何」；没完成的也要说没完成。`;

const TOOLS_HEADING = "你可以使用以下工具：";

const RULES: readonly string[] = [
	"修改已有文件用 edit，不要用 write 整段覆盖：write 会丢掉你没读到的部分。",
	"edit 的 oldText 必须与文件内容完全一致且只出现一次；不确定就先 read 一次。",
	"读大文件时用 offset 与 limit 分段读，不要试图一次读完。",
	"命令的输出可能被截断，末尾会说明；需要完整内容时缩小命令的范围。",
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
		cwd: `工作区根目录：${input.cwd}`,
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

/** 提示词里的分段与工具声明要一并记进会话，两者的变化都必须可重放。 */
export function toSessionTools(tools: readonly ToolDeclaration[]): readonly SessionToolDeclaration[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}
