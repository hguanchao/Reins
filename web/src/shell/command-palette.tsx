import { MessageSquarePlus, PanelRight, Search, Settings2, Sparkles, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { relativeTime } from "../lib/format.ts";
import type { SessionSummary } from "../protocol.ts";

interface PaletteItem {
	readonly key: string;
	readonly group: "命令" | "任务";
	readonly label: string;
	readonly hint?: string;
	readonly icon: typeof Search;
	run(): void;
}

/**
 * 命令面板。
 *
 * 两组共用一只输入框：命令与任务。分组标题是等宽小字，键盘上下移动跨组连续。
 */
export function CommandPalette({
	open,
	sessions,
	onClose,
	onNewTask,
	onSettings,
	onToggleTheme,
	onToggleSidePane,
	onCompact,
	onSwitchSession,
}: {
	readonly open: boolean;
	readonly sessions: readonly SessionSummary[];
	onClose(): void;
	onNewTask(): void;
	onSettings(): void;
	onToggleTheme(): void;
	onToggleSidePane(): void;
	onCompact(): void;
	onSwitchSession(session: SessionSummary): void;
}): ReactElement | null {
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [open]);

	const items = useMemo<readonly PaletteItem[]>(() => {
		const needle = query.trim().toLowerCase();
		const commands: readonly PaletteItem[] = ([
			{ key: "new", group: "命令", label: "新建任务", hint: "Ctrl N", icon: MessageSquarePlus, run: onNewTask },
			{ key: "settings", group: "命令", label: "打开设置", hint: "Ctrl ,", icon: Settings2, run: onSettings },
			{ key: "theme", group: "命令", label: "切换主题", icon: Sun, run: onToggleTheme },
			{ key: "side", group: "命令", label: "显示/隐藏侧面板", icon: PanelRight, run: onToggleSidePane },
			{ key: "compact", group: "命令", label: "压缩上下文", icon: Sparkles, run: onCompact },
		] satisfies readonly PaletteItem[]).filter(
			(item) => needle.length === 0 || item.label.toLowerCase().includes(needle),
		);

		const tasks: PaletteItem[] = sessions
			.filter((session) => needle.length === 0 || (session.title ?? "新任务").toLowerCase().includes(needle))
			.slice(0, 8)
			.map((session) => ({
				key: `session-${session.id}`,
				group: "任务" as const,
				label: session.title ?? "新任务",
				hint: relativeTime(session.updatedAt),
				icon: Sparkles,
				run: () => onSwitchSession(session),
			}));

		return [...commands, ...tasks];
	}, [query, sessions, onNewTask, onSettings, onToggleTheme, onToggleSidePane, onCompact, onSwitchSession]);

	useEffect(() => {
		setIndex((current) => (current >= items.length ? 0 : current));
	}, [items.length]);

	if (!open) return null;

	const choose = (item: PaletteItem | undefined): void => {
		if (item === undefined) return;
		onClose();
		item.run();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setIndex((current) => (items.length === 0 ? 0 : (current + 1) % items.length));
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setIndex((current) => (items.length === 0 ? 0 : (current - 1 + items.length) % items.length));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			choose(items[index]);
		}
	};

	return createPortal(
		<div
			className="palette-mask"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
				<div className="palette-h">
					<Search className="ic ic-14" />
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setIndex(0);
						}}
						onKeyDown={onKeyDown}
							placeholder="搜索命令或任务…"
						aria-label="命令面板搜索"
					/>
					<span className="badge">Esc</span>
				</div>
				<div className="palette-b">
					{items.length === 0 ? (
						<div className="empty" style={{ padding: 24 }}>
							<span className="d">没有匹配项</span>
						</div>
					) : (
						items.map((item, position) => {
							const Icon = item.icon;
							const head = item.group !== items[position - 1]?.group ? item.group : undefined;
							return (
								<div key={item.key}>
									{head === undefined ? null : <div className="palette-g">{head}</div>}
									<button
										type="button"
										aria-selected={position === index}
										onMouseEnter={() => setIndex(position)}
										onClick={() => choose(item)}
										className="palette-i"
										style={
											position === index ? { background: "var(--wash-2)", color: "var(--ink)" } : undefined
										}
									>
										<Icon className="ic ic-14" />
										<span className="lbl">{item.label}</span>
										{item.hint === undefined ? null : <span className="hint">{item.hint}</span>}
									</button>
								</div>
							);
						})
					)}
				</div>
				<div className="palette-f">
					<span>↑↓ 选择</span>
					<span>Enter 执行</span>
					<span>Esc 关闭</span>
				</div>
			</div>
		</div>,
		document.body,
	);
}
