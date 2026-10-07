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
  readonly description =
    'Write a file, replacing its entire contents. Parent directories are created automatically. Prefer edit for partial changes.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
      content: { type: 'string', description: 'Full file contents.' },
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
