import { stat } from 'node:fs/promises';
import { isFile, readTextFile } from '../util/fsx.ts';
import { absolutize } from '../util/paths.ts';
import {
  optionalNumber,
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './registry.ts';

/**
 * 读取工具:带回显行号的文本读取。
 *
 * 设计意图:行号让模型能精确引用位置;超过体积上限时拒绝整读,
 * 引导模型改用分页或搜索,避免把内存与上下文打爆。
 */

const MAX_FILE_BYTES = 5_000_000;

export class ReadTool implements Tool {
  readonly name = 'read';
  readonly description =
    'Read a file and return its contents with line numbers. Use offset and limit to page through large files.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
      offset: { type: 'number', description: 'First line to read (1-based).' },
      limit: { type: 'number', description: 'Maximum number of lines to read.' },
    },
    required: ['path'],
    additionalProperties: false,
  };
  readonly permissionKind = 'path-read' as const;

  targetOf(input: Record<string, unknown>, ctx: ToolContext) {
    return { path: absolutize(requireString(input, 'path', this.name), ctx.workspace) };
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = absolutize(requireString(input, 'path', this.name), ctx.workspace);
    if (!(await isFile(file))) {
      return { content: `文件不存在:${file}`, isError: true };
    }
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) {
      return {
        content: `文件过大(${info.size} 字节),请用 offset/limit 分页读取,或改用 grep 搜索:${file}`,
        isError: true,
      };
    }
    const text = await readTextFile(file);
    const lines = text.split(/\r?\n/);
    const rawOffset = optionalNumber(input, 'offset', this.name) ?? 1;
    const rawLimit = optionalNumber(input, 'limit', this.name) ?? lines.length;
    const start = Math.max(1, Math.floor(rawOffset));
    const limit = Math.max(0, Math.floor(rawLimit));
    const selected = lines.slice(start - 1, start - 1 + limit);
    const numbered = selected.map(
      (line, index) => `${String(start + index).padStart(4, ' ')}│ ${line}`,
    );
    return { content: numbered.join('\n'), isError: false };
  }
}
