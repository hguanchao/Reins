import type { Line } from "../text/line.ts";
import { plain } from "../text/line.ts";

/**
 * 旋转指示器。
 *
 * 它存在的理由是「让等待可见」：模型可能要想十几秒，没有动静的界面会被当成卡死。帧序列按
 * 时间取，而不是每收到一段输出就换一格——后者会让速度随机，看起来像在抖。
 */

const FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

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

/**
 * 耗时。
 *
 * 毫秒级直接给毫秒；十秒以内保留一位小数，再往上取整到秒；超过一分钟才出现分钟与小时。
 * 单位越小越精确，但显示越啰嗦，读的人只关心大概多久。
 */
export function formatDuration(elapsedMs: number): string {
	const ms = Math.max(0, Math.round(elapsedMs));
	if (ms < 1000) return `${ms}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;

	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m${totalSeconds % 60}s`;

	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}
