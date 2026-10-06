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
    '以下是一段编程会话的记录。请生成一份简明摘要,供后续对话作为上下文使用。',
    '需要保留:当前任务与目标、已确认的决策与理由、改动过的文件及要点、未完成事项、下一步计划。',
    '可以省略:寒暄、重复内容、与任务无关的过程细节。',
    '直接输出摘要正文,不要添加额外说明。',
    '',
    '会话记录:',
    transcript,
  ].join('\n');
}

const MAX_TRANSCRIPT_CHARS = 200_000;

/** 把会话条目格式化为用于摘要的纯文本;过长时保留最近的尾部。 */
export function formatTranscript(entries: SessionEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'user') {
      parts.push(`【用户】${entry.text}`);
    } else if (entry.type === 'assistant') {
      const calls =
        entry.toolCalls.length > 0
          ? `(工具调用:${entry.toolCalls.map((call) => call.name).join('、')})`
          : '';
      parts.push(`【助手】${entry.text}${calls}`);
    } else if (entry.type === 'tool_result') {
      const mark = entry.isError ? ',失败' : '';
      parts.push(`【工具结果:${entry.name}${mark}】${entry.content}`);
    } else if (entry.type === 'summary') {
      parts.push(`【历史摘要】${entry.text}`);
    }
  }
  const text = parts.join('\n\n');
  if (text.length <= MAX_TRANSCRIPT_CHARS) {
    return text;
  }
  return `…(较早内容已截断)…\n\n${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`;
}
