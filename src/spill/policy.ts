/**
 * 超大工具结果的落盘策略。
 *
 * 设计意图:结果超过阈值时完整写盘,上下文里只保留预览与位置指示,
 * 既保住信息又控制上下文占用;阈值为 0 时关闭。
 */

export function shouldSpill(text: string, threshold: number): boolean {
  return threshold > 0 && text.length > threshold;
}

/** 生成预览片段(默认取前 2000 字符)。 */
export function buildPreview(text: string, limit = 2000): string {
  return text.slice(0, limit);
}

/** 生成回填上下文的提示文本。 */
export function buildSpillNotice(path: string, totalChars: number, preview: string): string {
  return [
    `工具结果过长(${totalChars} 字符),已完整保存到:${path}`,
    '以下为预览:',
    preview,
    '(提示:可继续用 read 工具读取该文件的完整内容)',
  ].join('\n');
}
