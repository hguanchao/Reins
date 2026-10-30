import { describeError } from "../../shared/describe-error.ts";
import { graphemes } from "./text.ts";

/**
 * 状态行文案与短提示格式化。
 *
 * 状态行只有一行：控制字符会弄乱排版，过长的原因（端点常把整段错误体塞进消息里）会把
 * 计时与用量挤掉。所有进入状态行的外部文本都从这里收口。
 */

/** 等待模型回复：请求已发出，还没有任何增量到达。 */
export const WAITING_FOR_MODEL = "Waiting for model...";
/** 等待子代理：任务已经派出，结果还没回来。 */
export const WAITING_FOR_SUBAGENT = "Waiting for subagent...";
export const THINKING = "Thinking...";
export const WRITING_RESPONSE = "Writing response...";
/** 模型正在生成工具调用参数，工具尚未开始执行。 */
export const WRITING_TOOL_CALL = "Writing tool call...";
export const RUNNING_TOOL = "Running tool...";
export const COMPACTING_CONTEXT = "Compacting context...";
/** 配置不可用时按下回车给出的提示；不启动对话，避免看起来已经正常工作。 */
export const CONFIGURATION_REQUIRED = "Configuration required";
export const SESSION_UNAVAILABLE = "Session storage is unavailable";
/** 使用者按下中断之后的状态。主动停下不是错误，用中性措辞，不染错误色。 */
export const ABORTING = "Stopping...";
/** 对话流里的中断标记：说明这一轮的回答在这里被截断了，且是使用者自己停下的。 */
export const INTERRUPTED = "Stopped by you";
export const ERROR_STATUS = "Error";

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

