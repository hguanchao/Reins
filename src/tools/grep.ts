import { readTextFile } from '../util/fsx.ts';
import { absolutize, displayPath } from '../util/paths.ts';
import { walkFiles } from '../util/walk.ts';
import {
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './registry.ts';

/**
 * 内容搜索工具。
 *
 * 设计意图:流式遍历 + 逐文件读取,避免把整个仓库读进内存;
 * 结果给出 file:line 便于模型直接定位;默认跳过依赖与产物目录。
 */

const MAX_RESULT_LINES = 100;
const MAX_LINE_CHARS = 300;

export class GrepTool implements Tool {
  readonly name = 'grep';
  readonly description = '按正则表达式搜索文件内容,返回 file:line: 匹配行(忽略大小写)。';
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索起点(相对工作区,默认工作区根)' },
      max_results: { type: 'number', description: `最多返回条数(默认 ${MAX_RESULT_LINES})` },
    },
    required: ['pattern'],
    additionalProperties: false,
  };
  readonly permissionKind = 'path-read' as const;

  targetOf(input: Record<string, unknown>, ctx: ToolContext) {
    return { path: absolutize(optionalString(input, 'path', this.name) ?? '.', ctx.workspace) };
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = requireString(input, 'pattern', this.name);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { content: `正则表达式不合法:${detail}`, isError: true };
    }
    const root = absolutize(optionalString(input, 'path', this.name) ?? '.', ctx.workspace);
    const max = Math.max(1, Math.floor(optionalNumber(input, 'max_results', this.name) ?? MAX_RESULT_LINES));
    const matches: string[] = [];
    let truncated = false;

    search: for await (const file of walkFiles(root, { maxFileSize: 1_000_000, signal: ctx.signal })) {
      const text = await readTextFile(file).catch(() => null);
      if (text === null || text.includes('\0')) {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        if (regex.test(line)) {
          const trimmed = line.trim();
          const shown = trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
          matches.push(`${displayPath(file, ctx.workspace)}:${index + 1}: ${shown}`);
          if (matches.length >= max) {
            truncated = true;
            break search;
          }
        }
      }
    }

    if (matches.length === 0) {
      return { content: '未找到匹配。', isError: false };
    }
    const header = truncated ? `(结果达到上限 ${max} 条,可能不完整)\n` : '';
    return { content: header + matches.join('\n'), isError: false };
  }
}
