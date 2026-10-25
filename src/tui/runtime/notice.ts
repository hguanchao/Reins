import type { TuiState } from "./types.ts";

/**
 * 启动警告与平台说明。
 *
 * 两者都属于「启动时就知道的事」，合成一段交给对话流顶部；平台限制的沙箱说明
 * 不是可修复的配置问题，模型切换后仍然保留。
 */
export function noticeText(state: TuiState): string | undefined {
	const sandbox = state.sandboxNotice;
	const warning = state.activeWarning;
	if (sandbox === undefined || sandbox.length === 0) return warning;
	if (warning === undefined || warning.length === 0) return sandbox;
	return `${sandbox}\n\n${warning}`;
}
