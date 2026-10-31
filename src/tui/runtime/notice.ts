import type { TuiState } from "#src/tui/runtime/types.ts";

/**
 * 启动警告与平台说明。
 *
 * 三者都属于「启动时就知道的事」，合成一段交给对话流顶部；平台限制的沙箱说明
 * 与装载问题不是可修复的配置问题，模型切换后仍然保留。
 */
export function noticeText(state: TuiState): string | undefined {
	const parts = [state.sandboxNotice, state.startupProblems, state.activeWarning].filter(
		(part): part is string => part !== undefined && part.length > 0,
	);
	return parts.length === 0 ? undefined : parts.join("\n\n");
}
