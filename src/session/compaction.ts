import type { SessionEntry } from './store.ts';

/**
 * 会话压缩:策略、格式化与提示词。
 *
 * 设计意图:长会话会把上下文窗口挤爆,压缩的产物是一条 summary 条目;
 * 原始条目保留在文件中,只是不再进入后续请求——审计不受影响。
 */

/** 触发压缩的上下文使用率阈值。 */
export const DEFAULT_COMPACT_THRESHOLD = 0.75;

/** 使用率是否达到压缩阈值。 */
export function shouldCompact(
  usedTokens: number,
  contextWindow: number,
  threshold: number = DEFAULT_COMPACT_THRESHOLD,
): boolean {
  if (contextWindow <= 0) {
    return false;
  }
  return usedTokens >= contextWindow * threshold;
}

/** 生成压缩用的提示词;要求保留对后续工作真正有用的信息。 */
export function buildCompactionPrompt(transcript: string): string {
  return [
    'The conversation below is a coding session to summarize. Produce a structured checkpoint that another model can use to continue the work.',
    '',
    'Output exactly these sections, in this order, using terse bullets. Write "(none)" for an empty section; never drop a section.',
    '',
    '## Goal',
    '- [what the user is trying to accomplish]',
    '',
    '## Constraints',
    '- [requirements, preferences, or restrictions the user stated]',
    '',
    '## Progress',
    '- Done: [completed work]',
    '- In progress: [current work]',
    '- Blocked: [anything preventing progress]',
    '',
    '## Key decisions',
    '- [decision: brief rationale]',
    '',
    '## Files',
    '- [exact path: what changed and why it matters]',
    '',
    '## Next steps',
    '- [what should happen next, in order]',
    '',
    '## Critical context',
    '- [data, identifiers, or references needed to continue]',
    '',
    'Rules:',
    '- Preserve exact file paths, commands, error strings, identifiers, and numeric values.',
    '- Record user corrections and explicit instructions faithfully.',
    '- Do not mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text, with no extra commentary.',
    '',
    'Session transcript:',
    transcript,
  ].join('\n');
}

const MAX_TRANSCRIPT_CHARS = 200_000;

/** 把会话条目格式化为用于摘要的纯文本;过长时保留最近的尾部。 */
export function formatTranscript(entries: SessionEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'user') {
      parts.push(`[user] ${entry.text}`);
    } else if (entry.type === 'assistant') {
      const calls =
        entry.toolCalls.length > 0
          ? ` (tool calls: ${entry.toolCalls.map((call) => call.name).join(', ')})`
          : '';
      parts.push(`[assistant] ${entry.text}${calls}`);
    } else if (entry.type === 'tool_result') {
      const mark = entry.isError ? ', failed' : '';
      parts.push(`[tool_result: ${entry.name}${mark}] ${entry.content}`);
    } else if (entry.type === 'summary') {
      parts.push(`[earlier summary] ${entry.text}`);
    }
  }
  const text = parts.join('\n\n');
  if (text.length <= MAX_TRANSCRIPT_CHARS) {
    return text;
  }
  return `…(earlier content truncated)…\n\n${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`;
}
