/**
 * 渐隐滚动视口的纯逻辑:遮罩方向状态机与对应的 mask 工具类。
 * 与 React 解耦,便于在没有 DOM 的测试环境里直接验证。
 */

/** 滚动位置到渐隐方向的映射:四态足够,首尾各留一档不做无谓遮罩 */
export type ScrollMaskState = "none" | "top" | "bottom" | "both";

/** 视口边缘的渐隐带宽 */
export const SCROLL_FADE_PX = 24;

export const SCROLL_MASK_CLASS: Record<ScrollMaskState, string> = {
	none: "",
	top: `[mask-image:linear-gradient(to_bottom,transparent_0,black_${SCROLL_FADE_PX}px,black_100%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_${SCROLL_FADE_PX}px,black_100%)]`,
	bottom: `[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_${SCROLL_FADE_PX}px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_${SCROLL_FADE_PX}px),transparent_100%)]`,
	both: `[mask-image:linear-gradient(to_bottom,transparent_0,black_${SCROLL_FADE_PX}px,black_calc(100%_-_${SCROLL_FADE_PX}px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_${SCROLL_FADE_PX}px,black_calc(100%_-_${SCROLL_FADE_PX}px),transparent_100%)]`,
};

export function resolveScrollMaskState(viewport: {
	readonly scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}): ScrollMaskState {
	const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
	if (maxScrollTop <= 1) return "none";
	const hiddenTop = viewport.scrollTop > 1;
	const hiddenBottom = viewport.scrollTop < maxScrollTop - 1;
	if (hiddenTop && hiddenBottom) return "both";
	if (hiddenTop) return "top";
	if (hiddenBottom) return "bottom";
	return "none";
}
