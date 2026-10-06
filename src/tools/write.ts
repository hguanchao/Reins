import { writeTextFile } from '../util/fsx.ts';
import { absolutize } from '../util/paths.ts';
import {
  requireString,
  requireStringAllowEmpty,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './registry.ts';

/**
 * 写入工具:覆盖式写入,自动创建父目录。
 *
 * 设计意图:与编辑工具分工——新建或整体重写用 write,
 * 局部修改用 edit(带唯一性约束,更安全)。
 */
export class WriteTool implements Tool {
  readonly name = 'write';
  readonly description = '写入文件(整体覆盖),自动创建父目录。局部修改请优先使用 edit。';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径(相对工作区或绝对路径)' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  };
  readonly permissionKind = 'path-write' as const;

  targetOf(input: Record<string, unknown>, ctx: ToolContext) {
    return { path: absolutize(requireString(input, 'path', this.name), ctx.workspace) };
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = absolutize(requireString(input, 'path', this.name), ctx.workspace);
    const content = requireStringAllowEmpty(input, 'content', this.name);
    await writeTextFile(file, content);
    return { content: `已写入 ${file}(${content.length} 字符)`, isError: false };
  }
}
