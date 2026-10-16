import type { Line } from "../text/line.ts";
import { plain } from "../text/line.ts";

/**
 * 旋转指示器。
 *
 * 它存在的理由是「让等待可见」：模型可能要想十几秒，没有动静的界面会被当成卡死。帧序列按
 * 时间取，而不是每收到一段输出就换一格——后者会让速度随机，看起来像在抖。
 */

const FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 一帧多久换一次。比这更快只会闪，人眼分辨不出。 */
const FRAME_INTERVAL_MS = 120;

/** 取当前该显示的那一格。 */
export function spinnerFrame(elapsedMs: number): string {
	const index = Math.floor(Math.max(0, elapsedMs) / FRAME_INTERVAL_MS) % FRAMES.length;
	return FRAMES[index];
}

/** 一段带指示器的状态行。 */
export function spinnerLine(text: string, elapsedMs: number): Line {
	// 指示器与耗时都用灰色：它是活动的提示，不该比正文更抢眼
	return [{ text: spinnerFrame(elapsedMs), style: { color: "gray" } }, ...plain(` ${text} ${formatDuration(elapsedMs)}`)];
}

/** 耗时。毫秒级的直接给毫秒，工具调用大多数在一秒以内。 */
export function formatDuration(elapsedMs: number): string {
	const ms = Math.max(0, Math.round(elapsedMs));
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m${Math.round((ms % 60_000) / 1000)
		.toString()
		.padStart(2, "0")}s`;
}
