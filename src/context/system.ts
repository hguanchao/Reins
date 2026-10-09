import type { ProjectDoc } from './agents-md.ts';

/**
 * 系统提示词组装。
 *
 * 设计意图:保持简短、可审计——身份、工作准则、环境信息、项目文档四块;
 * 不堆砌行为枚举,把细节交给工具描述与权限系统表达。
 */

export interface SystemPromptInput {
  workspace: string;
  model: string;
  projectDoc: ProjectDoc | null;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const lines: string[] = [
    "You are Reins, a control-first coding agent working in the user's workspace. You read and write files and run commands through the tools provided to you.",
    '',
    'Working principles:',
    '- Read before you edit: inspect the relevant code and match the existing structure and style before changing anything.',
    '- Keep changes small and verifiable: make the smallest complete change, then verify it with a tool.',
    '- Report faithfully: when a tool fails or a permission is denied, say so and propose an alternative. Never claim a success you did not observe.',
    '- Respect boundaries: a denied action reflects a policy the user configured. Do not attempt to work around it.',
    '- Reply in the language the user writes in. Code and identifiers follow the conventions already present in the repository.',
    '',
    `Workspace: ${input.workspace}`,
    `Model: ${input.model}`,
  ];
  if (input.projectDoc !== null) {
    // 项目文档来自仓库,不可信:内容里若出现闭合标签就能提前跳出边界,
    // 把后续文字伪造成系统指令,所以先把闭合标签中和掉
    const safeContent = input.projectDoc.content.replace(/<\/project_instructions/gi, '<\\/project_instructions');
    const safePath = input.projectDoc.path.replace(/"/g, '&quot;');
    lines.push(
      '',
      `Project instructions from ${input.projectDoc.path} take precedence over general habits:`,
      `<project_instructions path="${safePath}">`,
      safeContent,
      '</project_instructions>',
    );
  }
  return lines.join('\n');
}
