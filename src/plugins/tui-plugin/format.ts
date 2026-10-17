/**
 * 界面上的数字写法。
 *
 * token 数动辄上十万，整串写出来会挤掉同一行里更有用的东西。这里统一按「一位小数 + 单位」
 * 压缩，阈值取 1000：一千以下原样写，一千以上才换算。
 */

/** token 数：不足一千原样写，往上按 k / M 折算，各留一位小数。 */
export function formatTokens(count: number): string {
	const value = Math.max(0, Math.round(count));
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 金额。不足一分钱时按分显示，免得一律写成 $0.00 看不出差别。 */
export function formatCost(amount: number): string {
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	return `$${amount.toFixed(2)}`;
}
