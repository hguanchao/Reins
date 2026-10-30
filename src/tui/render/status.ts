import { describeError } from "#src/shared/describe-error.ts";
import { graphemes } from "#src/tui/render/text.ts";

/**
 * 状态行的格式化。
 *
 * 文案本身在 `../copy.ts`：这里只负责把外部文本压成能放进一行状态行的形状。状态行只有一
 * 行，控制字符会弄乱排版，过长的原因（端点常把整段错误体塞进消息里）会把计时与用量挤掉，
 * 所以所有进入状态行的外部文本都从这里收口。
 */

/**
 * 重试原因压成一行短提示。
 *
 * 状态行只有一行：控制字符会弄乱排版，过长的原因会把计时与用量挤掉。
 */
export function shortReason(reason: string): string {
	const first = reason.split("\n", 1)[0] ?? "";
	const clean = first.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return truncateChars(clean, 40);
}

/** 附件读取失败时的单行原因；错误体常带换行，状态行只放得下第一行。 */
export function errorLine(error: unknown): string {
	const message = describeError(error);
	const first = message.split("\n", 1)[0] ?? "";
	const clean = first.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return truncateChars(clean, 80);
}

/** 按字素簇截断并补省略号：按码元切会把 emoji 之类的代理对劈成半个字符。 */
function truncateChars(text: string, limit: number): string {
	const chars = graphemes(text);
	if (chars.length <= limit) return text;
	return `${chars.slice(0, limit - 1).join("")}…`;
}

/** 批准计划后交给模型的用户消息：整份计划重新进入上下文，不依赖摘要里是否留下了它。 */
export function implementationPrompt(plan: string): string {
	return `Implement this plan:\n\n${plan.trim()}\n\nRe-read the files you need before changing them.`;
}
