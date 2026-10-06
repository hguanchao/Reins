import { isFile, readTextFile, writeTextFile } from '../util/fsx.ts';
import { absolutize } from '../util/paths.ts';
import {
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './registry.ts';

/**
 * 编辑工具:精确文本替换。
 *
 * 设计意图:强制 oldText 在文件中唯一出现——出现 0 次或多次都拒绝,
 * 让模型先读取足够上下文再改,把「改错位置」的概率压到最低。
 */
export class EditTool implements Tool {
  readonly name = 'edit';
  readonly description = '精确文本替换:oldText 需在文件中唯一出现;出现 0 次或多次时拒绝修改。';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径(相对工作区或绝对路径)' },
      oldText: { type: 'string', description: '要被替换的原文(需唯一)' },
      newText: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  };
  readonly permissionKind = 'path-write' as const;

  targetOf(input: Record<string, unknown>, ctx: ToolContext) {
    return { path: absolutize(requireString(input, 'path', this.name), ctx.workspace) };
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = absolutize(requireString(input, 'path', this.name), ctx.workspace);
    const oldText = requireString(input, 'oldText', this.name);
    const newText = typeof input['newText'] === 'string' ? input['newText'] : undefined;
    if (newText === undefined) {
      return { content: '参数 "newText" 缺失或不是字符串', isError: true };
    }
    if (!(await isFile(file))) {
      return { content: `文件不存在:${file}`, isError: true };
    }
    const text = await readTextFile(file);
    const occurrences = countOccurrences(text, oldText);
    if (occurrences === 0) {
      return { content: `未找到匹配的 oldText,未做修改:${file}`, isError: true };
    }
    if (occurrences > 1) {
      return {
        content: `oldText 在文件中出现 ${occurrences} 次,不唯一,未做修改;请扩大上下文后重试:${file}`,
        isError: true,
      };
    }
    await writeTextFile(file, text.replace(oldText, newText));
    return { content: `已修改 ${file}(替换 1 处)`, isError: false };
  }
}

function countOccurrences(text: string, needle: string): number {
  if (needle === '') {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
