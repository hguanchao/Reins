import { useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";

import { cn } from "../components/ui/cn.ts";
import type { Line } from "../transcript/lines.ts";
import { userMessageAnchors } from "./message-rail-model.ts";

const FLASH_MS = 1200;

export interface MessageRailProps {
	readonly lines: readonly Line[];
	readonly scrollRef: RefObject<HTMLDivElement | null>;
}

/**
 * 消息轨迹：贴着会话右缘的一条细脊，悬停展开提问列表，点击回到对应消息。
 * 轨迹只做定位，不复制回答与工具细节，避免和正文争夺注意力。
 */
export function MessageRail({ lines, scrollRef }: MessageRailProps): ReactElement | null {
	const items = useMemo(() => userMessageAnchors(lines), [lines]);
	const [open, setOpen] = useState(false);
	const [hovered, setHovered] = useState<number | undefined>(undefined);
	const [jumped, setJumped] = useState<number | undefined>(undefined);
	const [current, setCurrent] = useState<number | undefined>(undefined);
	const spineRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const flashTimer = useRef<number | null>(null);

	useEffect(() => {
		const panel = panelRef.current;
		if (panel !== null) panel.scrollTop = panel.scrollHeight;
	}, [items.length]);

	useEffect(() => {
		return () => {
			if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
		};
	}, []);

	// 视口中线附近的那条提问即当前位置；滚到提问之下才换人，不在顶部时不高亮。
	useEffect(() => {
		const viewport = scrollRef.current;
		if (viewport === null || items.length === 0) return;
		const elements = items
			.map((item) => viewport.querySelector<HTMLElement>(`[data-user-line="${item.index}"]`))
			.filter((element): element is HTMLElement => element !== null);
		if (elements.length === 0) return;

		let frame: number | null = null;
		const measure = (): void => {
			const boundary = viewport.getBoundingClientRect().top + viewport.clientHeight * 0.4;
			let next: number | undefined;
			for (let index = 0; index < elements.length; index += 1) {
				const element = elements[index];
				if (element !== undefined && element.getBoundingClientRect().top <= boundary) next = items[index]?.index;
			}
			setCurrent((value) => (value === next ? value : next));
		};
		const schedule = (): void => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => {
				frame = null;
				measure();
			});
		};

		measure();
		viewport.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		return () => {
			viewport.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			if (frame !== null) window.cancelAnimationFrame(frame);
		};
	}, [items, scrollRef]);

	const jump = (index: number): void => {
		const target = scrollRef.current?.querySelector<HTMLElement>(`[data-user-line="${index}"]`);
		if (target === null || target === undefined) return;
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		setCurrent(index);
		setJumped(index);
		// 面板盖住右对齐的气泡，跳过去后收起，先把消息露出来
		setOpen(false);
		if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setJumped(undefined), FLASH_MS);
	};

	if (items.length === 0) return null;

	return (
		<div
			className="absolute top-3 bottom-3 right-2 z-20 w-4"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			onBlur={(event) => {
				const next = event.relatedTarget;
				if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOpen(false);
			}}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				setOpen(false);
				spineRef.current?.focus();
			}}
		>
			<button
				ref={spineRef}
				type="button"
				aria-label="消息轨迹"
				aria-expanded={open}
				onFocus={() => setOpen(true)}
				onClick={() => setOpen(true)}
				className={cn(
					"absolute top-0 right-0 bottom-0 w-4 transition-opacity",
					open ? "pointer-events-none opacity-0" : "opacity-100",
				)}
			>
				<span className="absolute inset-y-2 right-[6.5px] w-px bg-border/70" />
				{items.map((item, index) => (
					<span
						key={item.index}
						className="absolute right-[4px] h-[2px] w-[6px] -translate-y-1/2 rounded-full bg-foreground-subtlest/70"
						style={{ top: `${((index + 1) / (items.length + 1)) * 100}%` }}
					/>
				))}
			</button>

			<div
				ref={panelRef}
				role="navigation"
				aria-label="消息轨迹"
				className={cn(
					"absolute top-0 right-0 flex max-h-full w-[min(220px,42vw)] flex-col overflow-y-auto overscroll-contain rounded-xl border-[0.5px] border-border bg-popover p-1.5 shadow-panel-prominent backdrop-blur-xl transition-[opacity,transform] duration-150",
					open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-1 opacity-0",
				)}
			>
				<ol className="flex flex-col">
					{items.map((item) => (
						<li key={item.index}>
							<button
								type="button"
								title={item.text}
								onClick={() => jump(item.index)}
								onMouseEnter={() => setHovered(item.index)}
								onMouseLeave={() => setHovered((value) => (value === item.index ? undefined : value))}
								className={cn(
									"line-clamp-2 block w-full rounded-md px-2.5 py-1.5 text-right text-[12px] leading-[18px] transition-colors",
									current === item.index || hovered === item.index || jumped === item.index
										? "bg-surface-hover text-foreground"
										: "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
								)}
							>
								{item.text.length === 0 ? "空消息" : item.text}
							</button>
						</li>
					))}
				</ol>
			</div>
		</div>
	);
}
