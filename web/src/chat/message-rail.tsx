import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactElement,
	type RefObject,
} from "react";

import { cn } from "../components/ui/cn.ts";
import type { Line } from "../transcript/lines.ts";
import {
	compactScrollTopFor,
	pickActiveAnchor,
	planOpenScroll,
	railMetrics,
	rowCenterY,
	selectRailSizerTexts,
	tickCenterY,
	truncateRailText,
	userMessageAnchors,
	type AnchorRect,
} from "./message-rail-model.ts";

const MIN_ANCHORS = 5; // 提问太少时轨迹没有导航价值，不出现
const MIN_VIEWPORT_WIDTH = 880; // 会话区过窄时展开面板没有容身之地，同样不出现
const OPEN_DELAY_MS = 60; // 悬停略停才展开，扫过右缘不会误触
const CLOSE_DELAY_MS = 180; // 离开稍等再收，在面板与刻度条之间移动时不闪收
const EXPAND_MS = 543; // 与展开动画同步，落定后提交滚动位置
const COLLAPSE_MS = 343; // 与收起动画同步，落定后还原滚动位置
const JUMP_TOP_GAP = 24; // 跳转后提问气泡距视口上缘的空隙，躲开顶部渐隐
const TEXT_LIMIT = 160;
const SIZER_LIMIT = 120;
const SIZER_SAMPLES = 24;

export interface MessageRailProps {
	readonly lines: readonly Line[];
	readonly scrollRef: RefObject<HTMLDivElement | null>;
}

/**
 * 消息轨迹：贴着会话右缘的一串刻度，悬停展开成提问面板，点击回到对应消息。
 * 收起与展开是同一份 DOM 的两套坐标，形态过渡交给 CSS；这里只负责状态机、
 * 活动提问跟随与滚动位置的提交，不复制回答与工具细节，避免和正文争夺注意力。
 */
export function MessageRail({ lines, scrollRef }: MessageRailProps): ReactElement | null {
	const items = useMemo(() => userMessageAnchors(lines), [lines]);
	const metrics = useMemo(() => railMetrics(items.length), [items.length]);
	const sizerTexts = useMemo(
		() => selectRailSizerTexts(items.map((item) => item.text), SIZER_SAMPLES, SIZER_LIMIT),
		[items],
	);

	const [viewportWidth, setViewportWidth] = useState(0);
	const [open, setOpen] = useState(false);
	const [settled, setSettled] = useState(false);
	const [hovered, setHovered] = useState<number | undefined>(undefined);
	const [measured, setMeasured] = useState<number | undefined>(undefined);
	const [pinned, setPinned] = useState<number | undefined>(undefined);
	const [fade, setFade] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });

	const rootRef = useRef<HTMLElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const compactScrollRef = useRef(0);
	const pendingScrollRef = useRef(0);
	const openTimerRef = useRef<number | null>(null);
	const closeTimerRef = useRef<number | null>(null);
	const expandTimerRef = useRef<number | null>(null);
	const collapseTimerRef = useRef<number | null>(null);
	const pinnedRef = useRef<number | undefined>(undefined);
	const measureFrameRef = useRef<number | null>(null);
	const reducedMotionRef = useRef(false);

	// 跳转未落定时钉住目标提问，不让滚动判定中途改选
	const displayedActive = pinned ?? measured;

	// 跳转后钉住目标提问：判定追上目标、或用户亲自滚动会话时才交还判定权，
	// 平滑滚动途中的 scroll 事件不算数——不然目标够不到判定线时高亮会弹回旧提问
	const clearPinning = useCallback((): void => {
		pinnedRef.current = undefined;
		setPinned(undefined);
	}, []);

	/** 视口里越过判定线的最近一条提问即当前位置；滚到底才换成最靠下的一条。 */
	const measure = useCallback((): void => {
		const viewport = scrollRef.current;
		if (viewport === null) return;
		const span = viewport.getBoundingClientRect();
		const rects: AnchorRect[] = [];
		for (const item of items) {
			const element = viewport.querySelector<HTMLElement>(`[data-user-line="${item.index}"]`);
			if (element === null) continue;
			const rect = element.getBoundingClientRect();
			rects.push({ index: item.index, top: rect.top, bottom: rect.bottom });
		}
		const atEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
		const next = pickActiveAnchor(rects, { top: span.top, bottom: span.bottom }, atEnd);
		if (next === undefined) return;
		if (pinnedRef.current !== undefined) {
			if (next !== pinnedRef.current) return;
			clearPinning();
		}
		setMeasured((value) => (value === next ? value : next));
	}, [items, scrollRef, clearPinning]);

	useEffect(() => {
		const viewport = scrollRef.current;
		if (viewport === null) return;
		const schedule = (): void => {
			if (measureFrameRef.current !== null) return;
			measureFrameRef.current = window.requestAnimationFrame(() => {
				measureFrameRef.current = null;
				measure();
			});
		};
		measure();
		viewport.addEventListener("scroll", schedule, { passive: true });
		// 滚轮、触摸与按键是用户亲手滚动的信号，此刻起滚动判定重新接管高亮
		const surrender = (): void => {
			if (pinnedRef.current !== undefined) clearPinning();
		};
		viewport.addEventListener("wheel", surrender, { passive: true });
		viewport.addEventListener("touchstart", surrender, { passive: true });
		viewport.addEventListener("keydown", surrender);
		const observer = new ResizeObserver(() => {
			setViewportWidth(viewport.clientWidth);
			schedule();
		});
		observer.observe(viewport);
		return () => {
			viewport.removeEventListener("scroll", schedule);
			viewport.removeEventListener("wheel", surrender);
			viewport.removeEventListener("touchstart", surrender);
			viewport.removeEventListener("keydown", surrender);
			observer.disconnect();
			if (measureFrameRef.current !== null) window.cancelAnimationFrame(measureFrameRef.current);
		};
	}, [measure, scrollRef, clearPinning]);

	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		reducedMotionRef.current = query.matches;
		const listener = (event: MediaQueryListEvent): void => {
			reducedMotionRef.current = event.matches;
		};
		query.addEventListener("change", listener);
		return () => query.removeEventListener("change", listener);
	}, []);

	/** 列表上下溢出时给边缘渐隐；收起态按刻度带内容高算，展开态按真实内容算。 */
	const syncFade = useCallback(
		(expanded: boolean): void => {
			const list = listRef.current;
			if (list === null || metrics === undefined) return;
			const contentHeight = expanded ? list.scrollHeight : metrics.compactContentHeight;
			const maxScroll = Math.max(0, contentHeight - list.clientHeight);
			const top = list.scrollTop > 1;
			const bottom = list.scrollTop < maxScroll - 1;
			setFade((value) => (value.top === top && value.bottom === bottom ? value : { top, bottom }));
		},
		[metrics],
	);

	/** 关过渡 → 写位置 → 强制回流 → 恢复过渡：滚动跳变必须一帧内完成。 */
	const commitScroll = useCallback((scrollTop: number): void => {
		const root = rootRef.current;
		const list = listRef.current;
		if (root === null || list === null) return;
		root.setAttribute("data-scroll-commit", "");
		root.style.setProperty("--rail-expanded-offset", "0px");
		root.style.setProperty("--rail-compact-offset", "0px");
		list.scrollTop = scrollTop;
		list.getBoundingClientRect();
		root.removeAttribute("data-scroll-commit");
	}, []);

	const commitOpen = useCallback((): void => {
		commitScroll(pendingScrollRef.current);
		setSettled(true);
		syncFade(true);
	}, [commitScroll, syncFade]);

	const openNow = useCallback((): void => {
		if (openTimerRef.current !== null) {
			window.clearTimeout(openTimerRef.current);
			openTimerRef.current = null;
		}
		if (collapseTimerRef.current !== null) {
			window.clearTimeout(collapseTimerRef.current);
			collapseTimerRef.current = null;
		}
		const root = rootRef.current;
		const list = listRef.current;
		if (root === null || list === null || open) return;
		const position =
			displayedActive === undefined
				? items.length - 1
				: items.findIndex((entry) => entry.index === displayedActive);
		const element = list.querySelector<HTMLElement>(`[data-rail-index="${position}"]`);
		const listRect = list.getBoundingClientRect();
		let activeScreenY = list.clientHeight / 2;
		if (element !== null) {
			const rect = element.getBoundingClientRect();
			activeScreenY = (rect.top + rect.bottom) / 2 - listRect.top;
		}
		const plan = planOpenScroll({
			activeIndex: position,
			activeScreenY,
			compactScrollTop: compactScrollRef.current,
			maxScroll: list.scrollHeight - list.clientHeight,
		});
		pendingScrollRef.current = plan.scrollTop;
		// 差值垫进位移变量：动画期间条目像是从原位渐变展开，落定后一次性提交滚动
		root.style.setProperty("--rail-expanded-offset", `${plan.visualOffset}px`);
		setHovered(undefined);
		setSettled(false);
		setOpen(true);
		syncFade(true);
		if (reducedMotionRef.current) {
			commitOpen();
			return;
		}
		expandTimerRef.current = window.setTimeout(() => {
			expandTimerRef.current = null;
			commitOpen();
		}, EXPAND_MS);
	}, [open, items, displayedActive, commitOpen, syncFade]);

	const closeNow = useCallback((): void => {
		if (expandTimerRef.current !== null) {
			window.clearTimeout(expandTimerRef.current);
			expandTimerRef.current = null;
		}
		const root = rootRef.current;
		const list = listRef.current;
		if (!open) return;
		if (root !== null && list !== null) {
			// 收起动画期间垫住位移，条目从展开行滑回收起刻度，而不是瞬移
			root.style.setProperty("--rail-compact-offset", `${list.scrollTop - compactScrollRef.current}px`);
		}
		setOpen(false);
		setSettled(false);
		setHovered(undefined);
		if (reducedMotionRef.current || root === null || list === null) {
			commitScroll(compactScrollRef.current);
			syncFade(false);
			return;
		}
		collapseTimerRef.current = window.setTimeout(() => {
			collapseTimerRef.current = null;
			commitScroll(compactScrollRef.current);
			syncFade(false);
		}, COLLAPSE_MS);
	}, [open, commitScroll, syncFade]);

	const scheduleOpen = useCallback((): void => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		if (open || openTimerRef.current !== null) return;
		openTimerRef.current = window.setTimeout(() => {
			openTimerRef.current = null;
			openNow();
		}, OPEN_DELAY_MS);
	}, [open, openNow]);

	const scheduleClose = useCallback((): void => {
		if (openTimerRef.current !== null) {
			window.clearTimeout(openTimerRef.current);
			openTimerRef.current = null;
		}
		if (!open || closeTimerRef.current !== null) return;
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			closeNow();
		}, CLOSE_DELAY_MS);
	}, [open, closeNow]);

	/** 当前提问变化时把列表滚到让它在两种布局里都居中；展开动画进行中则不动。 */
	useEffect(() => {
		if (displayedActive === undefined || metrics === undefined) return;
		if (open && !settled) return;
		const list = listRef.current;
		if (list === null) return;
		const position = items.findIndex((entry) => entry.index === displayedActive);
		const element = list.querySelector<HTMLElement>(`[data-rail-index="${position}"]`);
		if (element === null) return;
		const clamp = (value: number, maxScroll: number): number =>
			Math.max(0, Math.min(Math.max(0, maxScroll), value));
		const run = (): void => {
			const listRect = list.getBoundingClientRect();
			const rect = element.getBoundingClientRect();
			if (rect.top >= listRect.top && rect.bottom <= listRect.bottom) {
				if (!open) compactScrollRef.current = list.scrollTop;
				syncFade(open);
				return;
			}
			const contentHeight = open ? list.scrollHeight : metrics.compactContentHeight;
			const next = clamp(
				list.scrollTop + (rect.top + rect.bottom - listRect.top - listRect.bottom) / 2,
				contentHeight - list.clientHeight,
			);
			if (!open) compactScrollRef.current = next;
			if (Math.abs(next - list.scrollTop) > 1) list.scrollTo({ top: next });
			syncFade(open);
		};
		const frame = window.requestAnimationFrame(run);
		return () => window.cancelAnimationFrame(frame);
	}, [displayedActive, open, settled, metrics, items, syncFade]);

	// 面板开着时聊天仍在滚动的话，记住收起时该回到的刻度位置
	useEffect(() => {
		if (!open || displayedActive === undefined || metrics === undefined) return;
		const list = listRef.current;
		if (list === null) return;
		const position = items.findIndex((entry) => entry.index === displayedActive);
		if (position < 0) return;
		compactScrollRef.current = compactScrollTopFor({
			activeIndex: position,
			compactOffset: metrics.compactOffset,
			current: compactScrollRef.current,
			clientHeight: list.clientHeight,
			contentHeight: metrics.compactContentHeight,
		});
	}, [open, displayedActive, metrics, items]);

	const jump = useCallback(
		(position: number): void => {
			const viewport = scrollRef.current;
			const item = items[position];
			if (viewport === null || item === undefined) return;
			const target = viewport.querySelector<HTMLElement>(`[data-user-line="${item.index}"]`);
			if (target === null) return;
			const list = listRef.current;
			if (list !== null && metrics !== undefined) {
				compactScrollRef.current = compactScrollTopFor({
					activeIndex: position,
					compactOffset: metrics.compactOffset,
					current: compactScrollRef.current,
					clientHeight: list.clientHeight,
					contentHeight: metrics.compactContentHeight,
				});
			}
			const viewRect = viewport.getBoundingClientRect();
			const rect = target.getBoundingClientRect();
			viewport.scrollTo({
				top: viewport.scrollTop + rect.top - viewRect.top - JUMP_TOP_GAP,
				behavior: "smooth",
			});
			pinnedRef.current = item.index;
			setPinned(item.index);
		},
		[items, metrics, scrollRef],
	);

	// 会话流变化(换会话或来了新提问)后，旧的选中不再代表用户当前关注的位置
	useEffect(() => {
		clearPinning();
	}, [items.length, clearPinning]);

	// 轨迹从可见变不可见时全部复位，别让悬停定时器把面板留在打开状态
	const visible = metrics !== undefined && items.length >= MIN_ANCHORS && viewportWidth >= MIN_VIEWPORT_WIDTH;
	useEffect(() => {
		if (visible) return;
		for (const timer of [openTimerRef, closeTimerRef, expandTimerRef, collapseTimerRef]) {
			if (timer.current !== null) {
				window.clearTimeout(timer.current);
				timer.current = null;
			}
		}
		setOpen(false);
		setSettled(false);
		setHovered(undefined);
	}, [visible]);

	useEffect(() => {
		return () => {
			for (const timer of [openTimerRef, closeTimerRef, expandTimerRef, collapseTimerRef]) {
				if (timer.current !== null) window.clearTimeout(timer.current);
			}
			if (measureFrameRef.current !== null) window.cancelAnimationFrame(measureFrameRef.current);
		};
	}, []);

	if (metrics === undefined || !visible) return null;

	const railStyle = {
		"--rail-outer-height": `${metrics.outerHeight}px`,
		"--rail-compact-height": `${metrics.compactHeight}px`,
		"--rail-closed-inset-y": `${metrics.closedInsetY}px`,
		"--rail-open-inset-y": `${metrics.openInsetY}px`,
		"--rail-expanded-height": `${metrics.expandedHeight}px`,
		"--rail-rows-height": `${metrics.rowsHeight}px`,
		zIndex: 30,
	} as CSSProperties;

	return (
		<aside
			ref={rootRef}
			className={cn("message-rail", open && "message-rail--open", settled && "message-rail--settled")}
			style={railStyle}
			aria-label="消息轨迹"
			onMouseEnter={scheduleOpen}
			onMouseLeave={scheduleClose}
			onBlur={(event) => {
				const next = event.relatedTarget;
				if (!(next instanceof Node) || !event.currentTarget.contains(next)) closeNow();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") closeNow();
			}}
		>
			<div className="message-rail__panel-outer">
				<div className="message-rail__surface" aria-hidden="true" />
				<div className="message-rail__panel">
					<div className="message-rail__sizer" aria-hidden="true">
						{sizerTexts.map((text, position) => (
							<span key={position}>{text}</span>
						))}
					</div>
					<div
						ref={listRef}
						role={open ? "listbox" : undefined}
						aria-label={open ? "提问列表" : undefined}
						className={cn(
							"message-rail__list",
							fade.top && "message-rail__list--fade-top",
							fade.bottom && "message-rail__list--fade-bottom",
						)}
						onScroll={() => syncFade(true)}
					>
						<div className="message-rail__rows">
							{items.map((item, position) => {
								const active = displayedActive === item.index;
								return (
									<button
										key={item.index}
										type="button"
										role={open ? "option" : undefined}
										aria-selected={open ? active : undefined}
										aria-hidden={!open || undefined}
										tabIndex={open ? 0 : -1}
										data-rail-index={position}
										className={cn(
											"message-rail__item",
											hovered === item.index && "message-rail__item--hovered",
											active && "message-rail__item--active",
										)}
										style={
											{
												"--rail-tick-y": `${tickCenterY(metrics, position)}px`,
												"--rail-row-y": `${rowCenterY(position)}px`,
											} as CSSProperties
										}
										onMouseEnter={() => setHovered(item.index)}
										onMouseLeave={() => setHovered((value) => (value === item.index ? undefined : value))}
										onFocus={() => setHovered(item.index)}
										onBlur={() => setHovered((value) => (value === item.index ? undefined : value))}
										onClick={() => jump(position)}
									>
										<span className="message-rail__text">
											{item.text.length === 0 ? "空消息" : truncateRailText(item.text, TEXT_LIMIT)}
										</span>
										<span className="message-rail__tick" aria-hidden="true" />
									</button>
								);
							})}
						</div>
					</div>
				</div>
			</div>
			<button
				type="button"
				className="message-rail__hit"
				aria-label="消息轨迹"
				aria-expanded={open}
				onFocus={scheduleOpen}
				onClick={scheduleOpen}
			/>
		</aside>
	);
}
