import {
	Archive,
	Bell,
	Blocks,
	ChevronRight,
	CirclePlus,
	Folder,
	FolderOpen,
	Loader2,
	Pin,
	Settings2,
	Trash2,
	type LucideIcon,
} from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button, Menu, Popover, ScrollFadeViewport } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import { relativeTime, workspaceName } from "../lib/format.ts";
import { desktopBridge } from "../platform.ts";
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
}

/** 侧栏帧:导航组在顶部,任务列表占主体,功能入口收在底部。 */
export function Sidebar(props: SidebarProps): ReactElement {
	const [spaceOpen, setSpaceOpen] = useState(true);
	const [archivedOpen, setArchivedOpen] = useState(false);
	const bridge = desktopBridge();
	const pinnedSessions = props.sessions.filter((session) => props.pinned.has(session.id));
	const spaceSessions = props.sessions.filter((session) => !props.pinned.has(session.id));

	return (
		<aside
			className="flex h-full shrink-0 flex-col overflow-hidden rounded-(--workspace-panel-radius) border-[0.5px] border-border bg-sidebar shadow-xs"
			style={{ width: props.width }}
		>
			{/* 左上角浮动工具条悬在侧栏上方,这条占位让出工具条的高度 */}
			<div className="drag-region h-11 shrink-0" />
			<nav className="flex flex-col gap-1 px-2 pb-1">
				<button
					type="button"
					onClick={props.onNewTask}
					className="flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2.5 text-left text-ui-base font-medium text-foreground transition-colors hover:bg-surface-hover"
				>
					<CirclePlus className="size-4 shrink-0" />
					<span className="min-w-0 flex-1 truncate">新建任务</span>
					<span className="shrink-0 text-ui-sm text-foreground-subtlest">Ctrl N</span>
				</button>
				<NavRow icon={Blocks} label="插件" onClick={props.onOpenPluginsPlaceholder} />
				<NavRow icon={Archive} label="定时任务" onClick={props.onOpenScheduled} />
			</nav>

			<div className="min-h-0 flex-1 border-t border-border/50 pt-2">
				<ScrollFadeViewport className="h-full">
					<GroupHeading label={pinnedSessions.length > 0 ? "置顶" : undefined} />
					{pinnedSessions.length === 0 ? null : (
						<div className="flex flex-col gap-px px-2 pb-2">
							{pinnedSessions.map((session) => (
								<SessionRow key={session.id} {...props} session={session} />
							))}
						</div>
					)}

					<div className="flex items-center justify-between px-4 pb-1 pt-1">
						<button
							type="button"
							onClick={() => setSpaceOpen((value) => !value)}
							className="flex min-w-0 flex-1 items-center gap-1 text-left text-ui-base font-medium text-foreground-subtlest"
						>
							<ChevronRight
								className={cn(
									"size-3.5 shrink-0 transition-transform",
									spaceOpen && "rotate-90",
								)}
							/>
							<span className="min-w-0 truncate">{workspaceName(props.cwd)}</span>
						</button>
						{bridge === undefined ? null : (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="打开工作区"
								title="打开工作区"
								className="text-foreground-subtlest hover:text-foreground"
								onClick={() => {
									void bridge.chooseWorkspace();
								}}
							>
								<FolderOpen className="size-3.5" />
							</Button>
						)}
					</div>
					{spaceOpen ? (
						<div className="flex flex-col gap-px px-2">
							{spaceSessions.length === 0 ? (
								<div className="px-2.5 py-1.5 text-ui-sm text-foreground-subtlest">
									还没有任务
								</div>
							) : (
								spaceSessions.map((session) => (
									<SessionRow key={session.id} {...props} session={session} />
								))
							)}
						</div>
					) : (
						<div className="px-4 py-1.5">
							<Folder className="size-4 text-foreground-subtlest" />
						</div>
					)}

					{props.archived.length === 0 ? null : (
						<div className="mt-3 px-2">
							<button
								type="button"
								onClick={() => setArchivedOpen((value) => !value)}
								className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-ui-base text-foreground-subtle transition-colors hover:bg-surface-hover"
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
								<div className="mt-1 flex flex-col gap-px">
									{props.archived.map((session) => (
										<div
											key={session.id}
											className="group/row flex min-h-8 items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 hover:bg-surface-hover"
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
					<div className="h-2" />
				</ScrollFadeViewport>
			</div>

			<div className="flex h-11 shrink-0 items-center gap-1 px-3">
				<Popover
					trigger={({ toggle }) => (
						<Button variant="ghost" size="icon-sm" aria-label="通知" title="通知" onClick={toggle}>
							<Bell className="size-4" />
						</Button>
					)}
					className="w-64"
				>
					<div className="px-2 py-3 text-ui-sm text-foreground-subtle">暂无通知</div>
				</Popover>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="设置"
					title="设置"
					onClick={props.onOpenSettings}
				>
					<Settings2 className="size-4" />
				</Button>
				<span className="ml-auto shrink-0 font-mono text-ui-xs leading-none text-foreground-subtlest">
					v{props.version || "1.0.0"}
				</span>
			</div>
		</aside>
	);
}

function GroupHeading({ label }: { readonly label: string | undefined }): ReactElement {
	if (label === undefined) return <div className="h-2" />;
	return (
		<h3 className="px-4 pb-1 pt-1 text-ui-base font-medium text-foreground-subtlest">{label}</h3>
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
			className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-ui-base text-foreground transition-colors hover:bg-surface-hover"
		>
			<Icon className="size-4 shrink-0 text-foreground-subtle" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

/** 双行任务条目:首行标题,次行状态说明;前置 16px 槽位承载运行/置顶指示。 */
function SessionRow(
	props: SidebarProps & { readonly session: SessionSummary },
): ReactElement {
	const { session } = props;
	const active = session.id === props.currentId;
	const pinned = props.pinned.has(session.id);
	return (
		<div
			className={cn(
				"group/row flex min-h-9 items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 transition-colors",
				active ? "bg-selected" : "hover:bg-surface-hover",
			)}
		>
			<span className="flex size-4 shrink-0 items-center justify-center">
				{props.running && active ? (
					<Loader2 className="size-3.5 animate-spin text-foreground-subtle" />
				) : pinned ? (
					<Pin className="size-3 text-foreground-subtlest" />
				) : null}
			</span>
			<button
				type="button"
				onClick={() => props.onSwitch(session.id)}
				className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
			>
				<span className="min-w-0 truncate text-ui-base leading-tight text-foreground">
					{session.title ?? "新任务"}
				</span>
				<span className="flex items-center gap-1 text-ui-sm leading-tight text-foreground-subtlest">
					<span className="min-w-0 truncate">{pinned ? "已置顶" : "任务"}</span>
					<span className="ml-auto shrink-0 pl-2">{relativeTime(session.updatedAt)}</span>
				</span>
			</button>
			<div className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
				<Menu
					trigger={({ toggle }) => (
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="会话操作"
							title="会话操作"
							onClick={toggle}
						>
							<MoreGlyph />
						</Button>
					)}
					entries={[
						{
							type: "item",
							key: "pin",
							label: pinned ? "取消置顶" : "置顶",
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

/** 省略号图标:菜单入口的统一记号 */
function MoreGlyph(): ReactElement {
	return (
		<svg viewBox="0 0 16 16" className="size-3.5 fill-current" aria-hidden="true">
			<circle cx="3" cy="8" r="1.4" />
			<circle cx="8" cy="8" r="1.4" />
			<circle cx="13" cy="8" r="1.4" />
		</svg>
	);
}
