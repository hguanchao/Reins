/**
 * 页脚内容。
 *
 * 平时留空，占住整屏的最后一行。第一次按 Ctrl+C 时在这里提示还要再按一次；提示不改变
 * 主区域的可用高度，因此布局不会跟着跳动。
 */
export function renderFooter(exitArmed: boolean, width: number): readonly string[] {
	if (!exitArmed) return [""];
	const hint = "Press Ctrl+C again to exit";
	return [hint.slice(0, Math.max(0, width))];
}
