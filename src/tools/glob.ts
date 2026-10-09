import { absolutize, displayPath } from '../util/paths.ts';
import { globToRegExp } from '../util/glob.ts';
import { walkFiles } from '../util/walk.ts';
import {
  optionalString,
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './registry.ts';

/**
 * 文件查找工具。
 *
 * 设计意图:路径风格通配(支持 **);无分隔符的模式按文件名匹配,
 * 不符合的模式返回明确的空结果,方便模型调整而不是猜。
 */

const MAX_RESULTS = 200;

export class GlobTool implements Tool {
  readonly name = 'glob';
  readonly description =
    'Find files by glob pattern (** supported) and return paths relative to the workspace.';
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, for example src/**/*.ts or *.json.' },
      path: {
        type: 'string',
        description: 'Directory to search, relative to the workspace (defaults to the workspace root).',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  };
  readonly permissionKind = 'path-read' as const;

  targetOf(input: Record<string, unknown>, ctx: ToolContext) {
    return { path: absolutize(optionalString(input, 'path', this.name) ?? '.', ctx.workspace) };
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = requireString(input, 'pattern', this.name).replace(/\\/g, '/');
    const root = absolutize(optionalString(input, 'path', this.name) ?? '.', ctx.workspace);
    const regex = globToRegExp(pattern, {
      crossSeparator: false,
      caseInsensitive: process.platform === 'win32',
    });
    const byFileName = !pattern.includes('/');
    const results: string[] = [];
    let truncated = false;

    // glob 只看文件名,与体积无关:不设上限,否则大文件会永远搜不到
    for await (const file of walkFiles(root, {
      signal: ctx.signal,
      maxFileSize: Number.POSITIVE_INFINITY,
    })) {
      const relative = displayPath(file, ctx.workspace);
      const target = byFileName ? relative.slice(relative.lastIndexOf('/') + 1) : relative;
      if (regex.test(target)) {
        results.push(relative);
        if (results.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
      }
    }

    if (results.length === 0) {
      return { content: `未找到匹配 "${pattern}" 的文件。`, isError: false };
    }
    const header = truncated ? `(结果达到上限 ${MAX_RESULTS} 条,可能不完整)\n` : '';
    return { content: header + results.join('\n'), isError: false };
  }
}
