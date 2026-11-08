import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";

import type { Line } from "../transcript/lines.ts";
import {
	pickActiveAnchor,
	truncateRailText,
	userMessageAnchors,
	visibleTicks,
	type AnchorRect,
} from "./message-rail-model.ts";

const MIN_ANCHORS = 3;
const JUMP_GAP = 24;

/**
 * 右缘消息轨。
 *
 * 常驻的只是几条极弱刻度：定位是低频需求，不值得常驻占宽。悬停展开提问列表，点击跳到
 * 对应回合；当前所在的提问加粗加长。太短的会话不出现——两条刻度没有导航价值。
 */
export function MessageRail({
	lines,
	scrollRef,
}: {
	readonly lines: readonly Line[];
	readonly scrollRef: RefObject<HTMLDivElement | null>;
}): ReactElement | null {
	const anchors = useMemo(() => userMessageAnchors(lines), [lines]);
	const [active, setActive] = useState<number | undefined>(undefined);
	const frame = useRef<number | null>(null);

	const measure = useCallback((): void => {
		const viewport = scrollRef.current;
		if (viewport === null) return;
		const span = viewport.getBoundingClientRect();
		const rects: AnchorRect[] = [];
		for (const anchor of anchors) {
			const element = viewport.querySelector<HTMLElement>(`[data-user-line="${anchor.index}"]`);
			if (element === null) continue;
			const rect = element.getBoundingClientRect();
			rects.push({ index: anchor.index, top: rect.top, bottom: rect.bottom });
		}
		const atEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
		const next = pickActiveAnchor(rects, { top: span.top, bottom: span.bottom }, atEnd);
		if (next !== undefined) setActive((value) => (value === next ? value : next));
	}, [anchors, scrollRef]);

	useEffect(() => {
		const viewport = scrollRef.current;
		if (viewport === null) return;
		measure();
		const schedule = (): void => {
			if (frame.current !== null) return;
			frame.current = window.requestAnimationFrame(() => {
				frame.current = null;
				measure();
			});
		};
		viewport.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(viewport);
		return () => {
			viewport.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame.current !== null) window.cancelAnimationFrame(frame.current);
		};
	}, [measure, scrollRef]);

	if (anchors.length < MIN_ANCHORS) return null;

	const ticks = visibleTicks(anchors, active);

	const jump = (index: number): void => {
		const viewport = scrollRef.current;
		if (viewport === null) return;
		const target = viewport.querySelector<HTMLElement>(`[data-user-line="${index}"]`);
		if (target === null) return;
		const viewRect = viewport.getBoundingClientRect();
		const rect = target.getBoundingClientRect();
		viewport.scrollTo({ top: viewport.scrollTop + rect.top - viewRect.top - JUMP_GAP, behavior: "smooth" });
	};

	return (
		<nav className="msg-rail" aria-label="消息轨迹">
			<div className="msg-rail-track" aria-hidden="true">
				{ticks.map((tick) => (
					<i key={tick.index} className={tick.index === active ? "on" : undefined} />
				))}
			</div>
			<div className="msg-rail-pop" role="listbox" aria-label="提问列表">
				{ticks.map((tick, position) => (
					<button
						key={tick.index}
						type="button"
						role="option"
						aria-selected={tick.index === active}
						className={`msg-rail-i${tick.index === active ? " on" : ""}`}
						onClick={() => jump(tick.index)}
					>
						<span className="n">{String(position + 1).padStart(2, "0")}</span>
						<span className="tx">{tick.text.length === 0 ? "空消息" : truncateRailText(tick.text, 48)}</span>
					</button>
				))}
			</div>
		</nav>
	);
}
