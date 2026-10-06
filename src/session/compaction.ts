/**
 * 会话压缩:策略与提示词。
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
