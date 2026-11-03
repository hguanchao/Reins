import {
	FileText,
	MessageCirclePlus,
	PanelRight,
	Search,
	Settings2,
	Sparkles,
	Square,
	Sun,
} from "lucide-react";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactElement,
} from "react";
import { createPortal } from "react-dom";

import { api } from "../api.ts";
import { cn } from "../components/ui/cn.ts";
import { relativeTime } from "../lib/format.ts";
import type { SessionSummary } from "../protocol.ts";

interface PaletteItem {
	readonly key: string;
	readonly kind: "command" | "session" | "file";
	readonly label: string;
	readonly hint?: string;
	readonly icon: typeof Search;
	run(): void;
}

/** 命令面板：动作、会话与文件搜索共用一个输入框。 */
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
	onOpenFile,
}: {
	readonly open: boolean;
	readonly sessions: readonly SessionSummary[];
	onClose(): void;
	onNewTask(): void;
	onSettings(): void;
	onToggleTheme(): void;
	onToggleSidePane(): void;
	onCompact(): void;
	onSwitchSession(id: string): void;
	onOpenFile(path: string): void;
}): ReactElement | null {
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const [files, setFiles] = useState<readonly string[]>([]);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setIndex(0);
		setFiles([]);
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [open]);

	useEffect(() => {
		if (!open || query.trim().length === 0) {
			setFiles([]);
			return;
		}
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void api
				.fileSearch(query, 8)
				.then((hits) => {
					if (!cancelled) setFiles(hits.map((hit) => hit.path));
				})
				.catch(() => {});
		}, 150);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [open, query]);

	const items = useMemo<readonly PaletteItem[]>(() => {
		const needle = query.trim().toLowerCase();
		const allCommands: PaletteItem[] = [
			{ key: "new", kind: "command", label: "新任务", hint: "Ctrl N", icon: MessageCirclePlus, run: onNewTask },
			{ key: "settings", kind: "command", label: "打开设置", icon: Settings2, run: onSettings },
			{ key: "theme", kind: "command", label: "切换主题", icon: Sun, run: onToggleTheme },
			{ key: "side", kind: "command", label: "开合侧面板", icon: PanelRight, run: onToggleSidePane },
			{ key: "compact", kind: "command", label: "压缩上下文", icon: Square, run: onCompact },
		];
		const commands = allCommands.filter(
			(item) => needle.length === 0 || item.label.toLowerCase().includes(needle),
		);

		const sessionItems: PaletteItem[] = sessions
			.filter((session) => needle.length === 0 || (session.title ?? "新任务").toLowerCase().includes(needle))
			.slice(0, 8)
			.map((session) => ({
				key: `session-${session.id}`,
				kind: "session",
				label: session.title ?? "新任务",
				hint: relativeTime(session.updatedAt),
				icon: Sparkles,
				run: () => onSwitchSession(session.id),
			}));

		const fileItems: PaletteItem[] = files.map((path) => ({
			key: `file-${path}`,
			kind: "file",
			label: path,
			icon: FileText,
			run: () => onOpenFile(path),
		}));

		return [...commands, ...sessionItems, ...fileItems];
	}, [
		query,
		sessions,
		files,
		onNewTask,
		onSettings,
		onToggleTheme,
		onToggleSidePane,
		onCompact,
		onSwitchSession,
		onOpenFile,
	]);

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
			className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-xs"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="w-full max-w-xl overflow-hidden rounded-2xl border border-popover-border bg-popover shadow-md animate-pop">
				<div className="flex h-12 items-center gap-2 border-b border-border/50 px-4">
					<Search className="size-4 shrink-0 text-foreground-subtlest" />
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setIndex(0);
						}}
						onKeyDown={onKeyDown}
						placeholder="搜索命令、会话或文件…"
						className="min-w-0 flex-1 bg-transparent text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
						aria-label="命令面板搜索"
					/>
					<span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtlest">
						Esc
					</span>
				</div>
				<div className="max-h-[min(60vh,28rem)] overflow-y-auto p-1">
					{items.length === 0 ? (
						<div className="px-3 py-6 text-center text-ui-sm text-foreground-subtlest">没有匹配项</div>
					) : (
						items.map((item, itemIndex) => {
							const Icon = item.icon;
							return (
								<button
									key={item.key}
									type="button"
									onMouseEnter={() => setIndex(itemIndex)}
									onClick={() => choose(item)}
									className={cn(
										"flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base transition-colors",
										itemIndex === index
											? "bg-selected text-foreground"
											: "text-foreground-subtle hover:bg-surface-hover",
									)}
								>
									<Icon className="size-4 shrink-0 text-foreground-subtlest" />
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.hint === undefined ? null : (
										<span className="shrink-0 text-ui-xs text-foreground-subtlest">{item.hint}</span>
									)}
									<span className="shrink-0 text-ui-xs text-foreground-subtlest">
										{item.kind === "command" ? "命令" : item.kind === "session" ? "会话" : "文件"}
									</span>
								</button>
							);
						})
					)}
				</div>
				<div className="flex items-center gap-3 border-t border-border/50 px-4 py-2 text-ui-xs text-foreground-subtlest">
					<span>↑↓ 选择</span>
					<span>Enter 执行</span>
					<span>Esc 关闭</span>
				</div>
			</div>
		</div>,
		document.body,
	);
}
