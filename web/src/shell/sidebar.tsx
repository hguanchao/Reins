import {
	Archive,
	Bell,
	Blocks,
	ChevronRight,
	CirclePlus,
	Clock,
	Ellipsis,
	Folder,
	Loader2,
	Pin,
	Settings2,
	Trash2,
	type LucideIcon,
} from "lucide-react";
import { useState, type PointerEvent, type ReactElement } from "react";

import { Button, IconButton, Menu, Popover } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import { relativeTime, workspaceName } from "../lib/format.ts";
import type { SessionSummary } from "../protocol.ts";

export interface SidebarProps {
	readonly sessions: readonly SessionSummary[];
	readonly archived: readonly SessionSummary[];
	readonly pinned: ReadonlySet<string>;
	readonly currentId: string;
	readonly running: boolean;
	readonly cwd: string;
	readonly width: number;
	readonly version: string;
	onNewTask(): void;
	onSwitch(id: string): void;
	onArchive(id: string): void;
	onDelete(id: string): void;
	onRestore(id: string): void;
	onTogglePin(id: string): void;
	onOpenPluginsPlaceholder(): void;
	onOpenScheduled(): void;
	onOpenSettings(): void;
	onResizeStart(event: PointerEvent<HTMLDivElement>): void;
}

/** 侧栏：品牌、功能导航、置顶任务与工作区任务。 */
export function Sidebar(props: SidebarProps): ReactElement {
	const [spaceOpen, setSpaceOpen] = useState(true);
	const [archivedOpen, setArchivedOpen] = useState(false);
	const pinnedSessions = props.sessions.filter((session) => props.pinned.has(session.id));
	const spaceSessions = props.sessions.filter((session) => !props.pinned.has(session.id));

	return (
		<aside
			className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
			style={{ width: props.width }}
		>
			<div className="flex items-center justify-between gap-2 px-4 pb-3 pt-4">
				<div className="min-w-0 truncate text-ui-lg font-semibold tracking-tight text-foreground">
					Reins
				</div>
				<span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
					V{props.version || "1.0.0"}
				</span>
			</div>

			<div className="px-2 pb-2">
				<Button
					variant="ghost"
					size="lg"
					className="w-full justify-start gap-2 bg-surface-strong font-semibold hover:bg-surface-hover"
					onClick={props.onNewTask}
				>
					<CirclePlus className="size-4" />
					新建任务
				</Button>
			</div>

			<div className="flex flex-col gap-0.5 px-2">
				<NavRow icon={Blocks} label="插件" onClick={props.onOpenPluginsPlaceholder} />
				<NavRow icon={Clock} label="定时任务" onClick={props.onOpenScheduled} />
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto pb-3">
				<div className="mt-4 px-4 text-ui-sm font-medium text-foreground-subtle">
					任务 ({pinnedSessions.length})
				</div>
				{pinnedSessions.length === 0 ? (
					<div className="px-4 py-1.5 text-ui-sm text-foreground-subtlest">暂无任务</div>
				) : (
					<div className="mt-1 flex flex-col gap-px px-2">
						{pinnedSessions.map((session) => (
							<SessionRow key={session.id} {...props} session={session} />
						))}
					</div>
				)}

				<div className="mt-4 flex items-center justify-between px-4 text-ui-sm font-medium text-foreground-subtle">
					<span>空间 (1)</span>
				</div>
				<div className="mt-1 px-2">
					<button
						type="button"
						onClick={() => setSpaceOpen((value) => !value)}
						className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base text-foreground transition-colors hover:bg-surface-hover"
					>
						<Folder className="size-4 shrink-0 text-foreground-subtle" />
						<span className="min-w-0 flex-1 truncate">{workspaceName(props.cwd)}</span>
					</button>
					{spaceOpen ? (
						<div className="mt-1 flex flex-col gap-px pl-3">
							{spaceSessions.length === 0 ? (
								<div className="px-2 py-1.5 text-ui-sm text-foreground-subtlest">暂无任务</div>
							) : (
								spaceSessions.map((session) => (
									<SessionRow key={session.id} {...props} session={session} />
								))
							)}
						</div>
					) : null}
				</div>

				{props.archived.length === 0 ? null : (
					<div className="mt-4 px-2">
						<button
							type="button"
							onClick={() => setArchivedOpen((value) => !value)}
							className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base text-foreground-subtle transition-colors hover:bg-surface-hover"
						>
							<Archive className="size-4 shrink-0" />
							<span className="min-w-0 flex-1">已归档 ({props.archived.length})</span>
							<ChevronRight
								className={cn(
									"size-3.5 shrink-0 text-foreground-subtlest transition-transform",
									archivedOpen && "rotate-90",
								)}
							/>
						</button>
						{archivedOpen ? (
							<div className="mt-1 flex flex-col gap-px pl-3">
								{props.archived.map((session) => (
									<div
										key={session.id}
										className="group/row flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-surface-hover"
									>
										<span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
											{session.title ?? "未命名会话"}
										</span>
										<Button
											size="xs"
											variant="ghost"
											className="opacity-0 group-hover/row:opacity-100"
											onClick={() => props.onRestore(session.id)}
										>
											恢复
										</Button>
									</div>
								))}
							</div>
						) : null}
					</div>
				)}
			</div>

			<div className="flex h-14 shrink-0 items-center justify-end gap-1 border-t border-border/60 px-4">
				<Popover
					trigger={({ toggle }) => (
						<IconButton label="通知" size="icon-sm" onClick={toggle}>
							<Bell className="size-4" />
						</IconButton>
					)}
					className="w-64"
				>
					<div className="px-2 py-3 text-ui-sm text-foreground-subtle">暂无通知</div>
				</Popover>
				<IconButton label="设置" size="icon-sm" onClick={props.onOpenSettings}>
					<Settings2 className="size-4" />
				</IconButton>
			</div>

			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="调整侧栏宽度"
				onPointerDown={props.onResizeStart}
				className="group absolute right-0 top-0 z-10 h-full w-1 cursor-ew-resize touch-none"
			>
				<span className="absolute inset-y-2 right-0 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-resize-handle group-active:bg-resize-handle" />
			</div>
		</aside>
	);
}

function NavRow({
	icon: Icon,
	label,
	onClick,
}: {
	readonly icon: LucideIcon;
	readonly label: string;
	onClick(): void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base text-foreground transition-colors hover:bg-surface-hover"
		>
			<Icon className="size-4 shrink-0 text-foreground-subtle" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

function SessionRow(
	props: SidebarProps & { readonly session: SessionSummary },
): ReactElement {
	const { session } = props;
	const active = session.id === props.currentId;
	const pinned = props.pinned.has(session.id);
	return (
		<div
			className={cn(
				"group/row flex h-8 items-center gap-1 rounded-lg pl-2 pr-1 transition-colors",
				active ? "bg-surface-hover" : "hover:bg-surface-hover",
			)}
		>
			<button
				type="button"
				onClick={() => props.onSwitch(session.id)}
				className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
			>
				{props.running && active ? (
					<Loader2 className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
				) : pinned ? (
					<Pin className="size-3 shrink-0 text-foreground-subtlest" />
				) : null}
				<span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
					{session.title ?? "新任务"}
				</span>
				<span className="shrink-0 text-ui-sm text-foreground-subtlest">
					{relativeTime(session.updatedAt)}
				</span>
			</button>
			<div className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
				<Menu
					trigger={({ toggle }) => (
						<IconButton label="会话操作" size="icon-xs" onClick={toggle}>
							<Ellipsis className="size-3.5" />
						</IconButton>
					)}
					entries={[
						{
							type: "item",
							key: "pin",
							label: pinned ? "取消置顶" : "置顶到任务",
							icon: Pin,
							onSelect: () => props.onTogglePin(session.id),
						},
						{
							type: "item",
							key: "archive",
							label: "归档",
							icon: Archive,
							disabled: active,
							onSelect: () => props.onArchive(session.id),
						},
						{
							type: "item",
							key: "delete",
							label: "删除",
							icon: Trash2,
							danger: true,
							disabled: active,
							onSelect: () => props.onDelete(session.id),
						},
					]}
				/>
			</div>
		</div>
	);
}
