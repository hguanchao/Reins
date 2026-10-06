import type { ModelCost, Usage } from './types.ts';

/**
 * 用量累计与费用估算。
 *
 * 设计意图:token 与费用都是「可展示的信息」,不是准入条件;
 * 未在 providers.json 声明 cost 的模型只展示 token,不估算金额。
 */

export function estimateCost(usage: Usage, cost: ModelCost | undefined): number | undefined {
  if (cost === undefined) {
    return undefined;
  }
  const perMillion = 1_000_000;
  let total =
    (usage.inputTokens / perMillion) * cost.input +
    (usage.outputTokens / perMillion) * cost.output;
  if (usage.cacheReadTokens !== undefined && cost.cacheRead !== undefined) {
    total += (usage.cacheReadTokens / perMillion) * cost.cacheRead;
  }
  if (usage.cacheWriteTokens !== undefined && cost.cacheWrite !== undefined) {
    total += (usage.cacheWriteTokens / perMillion) * cost.cacheWrite;
  }
  return total;
}

/** 累加两次用量;可选字段在两边都缺失时保持缺失。 */
export function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: sumOptional(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: sumOptional(left.cacheWriteTokens, right.cacheWriteTokens),
  };
}

/** 生成一行可读的用量摘要。 */
export function formatUsage(usage: Usage, cost: ModelCost | undefined): string {
  const parts = [`输入 ${usage.inputTokens}`, `输出 ${usage.outputTokens}`];
  if (usage.cacheReadTokens !== undefined) {
    parts.push(`缓存读 ${usage.cacheReadTokens}`);
  }
  const money = estimateCost(usage, cost);
  if (money !== undefined) {
    parts.push(`估算费用 $${money.toFixed(4)}`);
  }
  return parts.join(' / ');
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}
