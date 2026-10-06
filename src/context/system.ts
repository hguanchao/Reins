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
    '你是 Reins,一个可控优先的编程智能体,在用户的机器上工作,通过工具读写文件、执行命令。',
    '',
    '工作准则:',
    '1. 先读后改:修改文件前先阅读相关代码,理解现有结构与风格。',
    '2. 小步验证:改动尽量小而完整,完成后用工具验证结果。',
    '3. 如实汇报:工具失败或被权限拒绝时,说明情况并给出替代方案,不要伪装成功。',
    '4. 尊重边界:被拒绝的操作是用户设定的策略约束,不要尝试绕行。',
    '5. 默认使用中文回复;代码与标识符遵循项目既有约定。',
    '',
    `工作区: ${input.workspace}`,
    `当前模型: ${input.model}`,
  ];
  if (input.projectDoc !== null) {
    lines.push(
      '',
      `项目文档(${input.projectDoc.path}),其中的约定优先于通用习惯:`,
      '<项目文档>',
      input.projectDoc.content,
      '</项目文档>',
    );
  }
  return lines.join('\n');
}
