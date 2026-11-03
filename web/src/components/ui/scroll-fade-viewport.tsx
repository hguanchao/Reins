import {
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
	type ComponentProps,
	type Ref,
} from "react";

import { cn } from "./cn.ts";
import { SCROLL_MASK_CLASS, resolveScrollMaskState, type ScrollMaskState } from "./scroll-mask.ts";

/**
 * 边缘渐隐滚动视口:内容贴边处 24px 渐隐,随滚动位置切换遮罩方向。
 * 滚动节点直接外露(ref 透传),调用方原有的吸底与滚动监听不受影响。
 */
export function ScrollFadeViewport({
	className,
	ref,
	children,
	...props
}: ComponentProps<"div"> & { readonly ref?: Ref<HTMLDivElement> }): React.ReactElement {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [mask, setMask] = useState<ScrollMaskState>("none");

	useImperativeHandle(ref, () => viewportRef.current as HTMLDivElement, []);

	useEffect(() => {
		const viewport = viewportRef.current;
		const content = contentRef.current;
		if (viewport === null || content === null) {
			setMask("none");
			return;
		}

		let frame: number | null = null;
		const update = (): void => {
			setMask(resolveScrollMaskState(viewport));
		};
		// 滚动与尺寸变化都合并到下一帧,避免高频 setState
		const schedule = (): void => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => {
				frame = null;
				update();
			});
		};

		update();
		viewport.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(viewport);
		observer.observe(content);
		return () => {
			viewport.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame !== null) window.cancelAnimationFrame(frame);
		};
	}, []);

	return (
		<div
			{...props}
			ref={viewportRef}
			data-scroll-mask={mask}
			className={cn("overflow-y-auto", SCROLL_MASK_CLASS[mask], className)}
		>
			<div ref={contentRef} className="min-h-full w-full">
				{children}
			</div>
		</div>
	);
}
