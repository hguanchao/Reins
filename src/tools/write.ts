import { writeTextFile } from '../util/fsx.ts';
import { formatDiff, lineDiff } from './diff.ts';
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

  /** 审批前预览:新建或覆盖看不出「改了什么」,给出前几行内容。 */
  previewOf(input: Record<string, unknown>): string[] | undefined {
    const content = typeof input['content'] === 'string' ? input['content'] : undefined;
    if (content === undefined) {
      return undefined;
    }
    const preview = formatDiff(lineDiff('', content, { context: 0, maxLines: 8 }));
    return preview === '' ? undefined : preview.split('\n');
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = absolutize(requireString(input, 'path', this.name), ctx.workspace);
    const content = requireStringAllowEmpty(input, 'content', this.name);
    await writeTextFile(file, content);
    // 新建/覆盖看不出「改了什么」,给出前几行内容当预览
    const preview = formatDiff(lineDiff('', content, { context: 0, maxLines: 12 }));
    return {
      content: preview === '' ? `已写入 ${file}(${content.length} 字符)` : `已写入 ${file}(${content.length} 字符)
${preview}`,
      isError: false,
    };
  }
}
