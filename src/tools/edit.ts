import { isFile, readTextFile, writeTextFile } from '../util/fsx.ts';
import { formatDiff, lineDiff } from './diff.ts';
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
  readonly description =
    'Replace exact text in a file. oldText must occur exactly once; the edit is rejected when it occurs zero or multiple times.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
      oldText: { type: 'string', description: 'Exact existing text to replace (must be unique).' },
      newText: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  };
  readonly permissionKind = 'path-write' as const;

  targetOf(input: Record<string, unknown>, ctx: ToolContext) {
    return { path: absolutize(requireString(input, 'path', this.name), ctx.workspace) };
  }

  /** 审批前预览:把 oldText → newText 的改动摊成几行。 */
  previewOf(input: Record<string, unknown>): string[] | undefined {
    const oldText = typeof input['oldText'] === 'string' ? input['oldText'] : undefined;
    const newText = typeof input['newText'] === 'string' ? input['newText'] : undefined;
    if (oldText === undefined || newText === undefined) {
      return undefined;
    }
    const before = oldText.split('\r\n').join('\n');
    const after = newText.split('\r\n').join('\n');
    const diff = formatDiff(lineDiff(before, after));
    return diff === '' ? undefined : diff.split('\n');
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
    // read 工具按 \r?\n 拆行,模型看到的文本一律是 \n;匹配时把 oldText 的 \n
    // 视为「任意行尾」,直接在原文上替换——这样未改动的行保持各自原本的行尾,
    // 混合行尾的文件不会被整体改写成 CRLF
    const needle = oldText.replace(/\r\n/g, '\n');
    const pattern = buildPattern(needle);
    const matches = text.match(pattern);
    const occurrences = matches === null ? 0 : matches.length;
    if (occurrences === 0) {
      return { content: `未找到匹配的 oldText,未做修改:${file}`, isError: true };
    }
    if (occurrences > 1) {
      return {
        content: `oldText 在文件中出现 ${occurrences} 次,不唯一,未做修改;请扩大上下文后重试:${file}`,
        isError: true,
      };
    }
    // 替换值走函数形式:字符串形式会把 newText 里的 $&、$$ 当替换模式展开,
    // 静默写坏文件(写 shell 脚本与模板时很常见)
    const replacement = newText.replace(/\r\n/g, '\n');
    // 命中片段自带换行时沿用它的行尾;只替换单行内容时退回文件的主流行尾,
    // 否则往 CRLF 文件里插入多行会混进裸 LF
    const dominantEol = text.includes('\r\n') ? '\r\n' : '\n';
    const updated = text.replace(pattern, (matched) => {
      const eol = matched.includes('\r\n') ? '\r\n' : dominantEol;
      return replacement.replace(/\n/g, eol);
    });
    await writeTextFile(file, updated);
    // 结果带上紧凑差异:界面里一眼看到改了什么,模型也据此确认(几行,不占多少上下文)
    const diff = formatDiff(lineDiff(needle, replacement));
    return {
      content: diff === '' ? `已修改 ${file}(替换 1 处)` : `已修改 ${file}(替换 1 处)
${diff}`,
      isError: false,
    };
  }
}

/** 把 oldText 编译成「换行符无关」的全局正则:字面量转义,`\n` 匹配 \n 或 \r\n。 */
function buildPattern(needle: string): RegExp {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\n/g, '\\r?\\n'), 'g');
}
