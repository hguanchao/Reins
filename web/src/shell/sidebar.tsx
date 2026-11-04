import {
	Archive,
	ArchiveRestore,
	Blocks,
	CalendarClock,
	ChevronDown,
	Ellipsis,
	Folder,
	FolderPlus,
	Pin,
	Search,
	Settings,
	SlidersHorizontal,
	SquarePen,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import { StateDot } from "../components/state-dot.tsx";
import { Button, Menu, type MenuEntry } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import { relativeTime, workspaceName } from "../lib/format.ts";
import { desktopBridge } from "../platform.ts";
import type { SessionSummary } from "../protocol.ts";
import {
	archivedFilterLabel,
	buildSessionRows,
	sidebarSectionVisibility,
	type ArchivedFilter,
	type SessionRow,
} from "./session-tree.ts";

export type GlobalPanelId = "plugins" | "schedules";

export interface SidebarProps {
	readonly sessions: readonly SessionSummary[];
	readonly archived: readonly SessionSummary[];
	readonly pinned: ReadonlySet<string>;
	readonly currentId: string;
	/** 当前会话还没有任何内容（尚未发送第一条消息），侧栏不为它补行 */
	readonly currentIsDraft: boolean;
	readonly running: boolean;
	readonly cwd: string;
	readonly version: string;
	readonly connected: boolean;
	readonly activePanel: GlobalPanelId | undefined;
	onNewSession(): void;
	onSwitch(id: string): void;
	onArchive(id: string): void;
	onDelete(id: string): void;
	onRestore(id: string): void;
	onTogglePin(id: string): void;
	onOpenPanel(panel: GlobalPanelId): void;
	onOpenSettings(): void;
}

const ARCHIVED_FILTERS: readonly ArchivedFilter[] = ["hide", "show", "only"];

/** 侧栏：品牌、新会话、全局面板、工作区浏览区与底部设置。 */
export function Sidebar(props: SidebarProps): ReactElement {
	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [tasksOpen, setTasksOpen] = useState(true);
	const [spacesOpen, setSpacesOpen] = useState(true);
	const [archivedFilter, setArchivedFilter] = useState<ArchivedFilter>("hide");
	const searchInput = useRef<HTMLInputElement | null>(null);
	const bridge = desktopBridge();
	const rows = buildSessionRows({
		sessions: props.sessions,
		archived: props.archived,
		pinned: props.pinned,
		query,
		archivedFilter,
		currentId: props.currentId,
		currentIsDraft: props.currentIsDraft,
	});

	useEffect(() => {
		if (!searchOpen) return;
		searchInput.current?.focus({ preventScroll: true });
	}, [searchOpen]);

	const sectionOpen = sidebarSectionVisibility(query.trim().length > 0, tasksOpen, spacesOpen);

	const viewOptions: MenuEntry[] = [
		{ type: "label", label: "分组" },
		{ type: "item", key: "group-workspace", label: "按工作区", checked: true, onSelect: () => {} },
		{ type: "item", key: "group-flat", label: "全部会话（未接入）", checked: false, disabled: true, onSelect: () => {} },
		{ type: "separator" },
		{ type: "label", label: "排序" },
		{ type: "item", key: "order-updated", label: "按更新时间", checked: true, onSelect: () => {} },
		{ type: "item", key: "order-manual", label: "手动排序（未接入）", checked: false, disabled: true, onSelect: () => {} },
		{ type: "separator" },
		{ type: "label", label: "归档" },
		...ARCHIVED_FILTERS.map<MenuEntry>((filter) => ({
			type: "item",
			key: filter,
			label: archivedFilterLabel(filter),
			checked: archivedFilter === filter,
			onSelect: () => setArchivedFilter(filter),
		})),
	];

	return (
		<aside className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar px-3 pt-1.5 pb-1.5 text-foreground">
			<div className="flex h-10 shrink-0 items-center gap-2 pl-1">
				<BrandMark size={24} className="text-foreground" />
				<span className="min-w-0 truncate text-[18px] leading-6 font-semibold tracking-[0.04em]">Reins</span>
				{props.version.length === 0 ? null : (
					<span className="ml-auto shrink-0 font-mono text-[10px] leading-4 text-foreground-subtlest">
						v{props.version}
					</span>
				)}
			</div>

			<button
				type="button"
				onClick={props.onNewSession}
				className="group/new relative mx-0.5 mt-2 mb-3 flex h-[38px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border-[0.5px] border-border bg-card px-3 text-[14px] leading-[22px] font-medium transition-colors hover:bg-surface-hover"
			>
				<SquarePen className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">新会话</span>
				<span className="absolute right-3 shrink-0 text-[12px] font-normal text-foreground-subtlest opacity-0 transition-opacity group-hover/new:opacity-100">
					Ctrl N
				</span>
			</button>

			<nav className="mb-2 flex shrink-0 flex-col gap-0.5">
				<PanelRow
					icon={<Blocks className="size-4" />}
					label="插件"
					active={props.activePanel === "plugins"}
					onClick={() => props.onOpenPanel("plugins")}
				/>
				<PanelRow
					icon={<CalendarClock className="size-4" />}
					label="定时任务"
					active={props.activePanel === "schedules"}
					onClick={() => props.onOpenPanel("schedules")}
				/>
			</nav>

			<div className="flex min-h-0 flex-1 flex-col">
				<div className="mb-1 flex h-9 shrink-0 items-center gap-1 pl-1">
					{searchOpen ? (
						<div className="flex h-[30px] min-w-0 flex-1 items-center gap-0 rounded-md border-[0.5px] border-border-hover px-2">
							<Search className="size-3.5 shrink-0 text-foreground-subtlest" />
							<input
								ref={searchInput}
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== "Escape") return;
									event.preventDefault();
									setQuery("");
									setSearchOpen(false);
								}}
								placeholder="搜索会话"
								aria-label="搜索会话"
								className="min-w-0 flex-1 bg-transparent px-1 text-[13px] leading-[18px] outline-none placeholder:text-foreground-subtlest"
							/>
							<button
								type="button"
								aria-label="清除搜索"
								onClick={() => {
									setQuery("");
									setSearchOpen(false);
								}}
								className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover"
							>
								<X className="size-3" />
							</button>
						</div>
					) : (
						<>
							<span className="min-w-0 flex-1" />
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="搜索会话"
								title="搜索会话"
								className="size-7 rounded-sm text-foreground-subtle hover:bg-surface-hover"
								onClick={() => setSearchOpen(true)}
							>
								<Search className="size-3.5" />
							</Button>
							<Menu
								trigger={({ toggle }) => (
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="视图选项"
										title="视图选项"
										className="size-7 rounded-sm text-foreground-subtle hover:bg-surface-hover"
										onClick={toggle}
									>
										<SlidersHorizontal className="size-3.5" />
									</Button>
								)}
								entries={viewOptions}
								className="min-w-[200px]"
							/>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="添加工作区"
								title="添加工作区"
								disabled={bridge === undefined}
								className="size-7 rounded-sm text-foreground-subtle hover:bg-surface-hover"
								onClick={() => {
									void bridge?.chooseWorkspace();
								}}
							>
								<FolderPlus className="size-4" />
							</Button>
						</>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto pb-4">
					<SectionHeader
						label="任务"
						count={rows.length}
						open={sectionOpen.tasks}
						onToggle={() => setTasksOpen((value) => !value)}
						addLabel="新建会话"
						onAdd={props.onNewSession}
					/>
					<div className="sidebar-section-motion" data-open={sectionOpen.tasks || undefined}>
						<div className="sidebar-section-content">
							{rows.length === 0 ? (
								<div className="flex flex-col items-center gap-2 px-3 py-6 text-[13px] leading-5 text-foreground-subtlest">
									<Archive className="size-6 text-foreground-subtlest" />
									<span>{query.length > 0 ? "没有匹配的会话" : "还没有会话"}</span>
								</div>
							) : (
								<div className="flex flex-col gap-0.5">
									{rows.map((row) => (
										<SessionRowView
											key={row.id}
											row={row}
											current={row.id === props.currentId && props.activePanel === undefined}
											running={props.running && row.id === props.currentId}
											onSwitch={() => props.onSwitch(row.id)}
											onArchive={() => props.onArchive(row.id)}
											onDelete={() => props.onDelete(row.id)}
											onRestore={() => props.onRestore(row.id)}
											onTogglePin={() => props.onTogglePin(row.id)}
										/>
									))}
								</div>
							)}
						</div>
					</div>

					<SectionHeader
						label="空间"
						count={1}
						open={sectionOpen.spaces}
						onToggle={() => setSpacesOpen((value) => !value)}
						addLabel="添加工作区"
						onAdd={() => {
							void bridge?.chooseWorkspace();
						}}
						addDisabled={bridge === undefined}
					/>
					<div className="sidebar-section-motion" data-open={sectionOpen.spaces || undefined}>
						<div className="sidebar-section-content">
							<WorkspaceRow
								name={workspaceName(props.cwd) || "Reins"}
								onNewSession={props.onNewSession}
								onArchiveFilter={() => {
									const index = ARCHIVED_FILTERS.indexOf(archivedFilter);
									setArchivedFilter(ARCHIVED_FILTERS[(index + 1) % ARCHIVED_FILTERS.length] ?? "hide");
								}}
							/>
						</div>
					</div>
				</div>
			</div>

			<div className="mt-1 flex h-[42px] shrink-0 items-center gap-2 rounded-md px-2.5 transition-colors hover:bg-surface-hover">
				<button
					type="button"
					onClick={props.onOpenSettings}
					className="flex min-w-0 flex-1 items-center gap-2 text-left text-[14px] leading-[22px]"
				>
					<Settings className="size-4 shrink-0" />
					<span className="min-w-0 truncate">设置</span>
				</button>
				{props.connected ? null : (
					<span title="连接已断开" className="shrink-0">
						<StateDot state="warning" />
					</span>
				)}
			</div>
		</aside>
	);
}

function PanelRow({
	icon,
	label,
	active,
	onClick,
}: {
	readonly icon: ReactElement;
	readonly label: string;
	readonly active: boolean;
	onClick(): void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={cn(
				"mx-0.5 flex min-h-9 items-center gap-2 rounded-md px-2 py-[7px] text-left text-[14px] leading-[22px] transition-colors hover:bg-surface-hover",
				active && "bg-selected",
			)}
		>
			<span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

/**
 * 分组标题：吸顶、12px 加粗、折叠箭头与 hover 才出现的「+」。
 * 两段共用一套形态（任务 / 空间），与 WorkBuddy 的 Tasks / Workspaces 对应。
 */
function SectionHeader({
	label,
	count,
	open,
	onToggle,
	addLabel,
	onAdd,
	addDisabled,
}: {
	readonly label: string;
	readonly count: number;
	readonly open: boolean;
	onToggle(): void;
	readonly addLabel: string;
	onAdd(): void;
	readonly addDisabled?: boolean;
}): ReactElement {
	return (
		<div className="group/section sticky top-0 z-10 flex h-[30px] items-center gap-1 rounded-md bg-sidebar px-2">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
			>
				<ChevronDown className={cn("size-3.5 shrink-0 text-foreground-subtlest transition-transform", !open && "-rotate-90")} />
				<span className="truncate text-[12px] leading-4 font-semibold text-foreground-subtle">{label}</span>
				<span className="shrink-0 text-[12px] leading-4 text-foreground-subtlest">{count}</span>
			</button>
			<button
				type="button"
				aria-label={addLabel}
				title={addLabel}
				disabled={addDisabled}
				onClick={onAdd}
				className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtlest opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover/section:opacity-100 group-focus-within/section:opacity-100 disabled:hidden"
			>
				<FolderPlus className="size-3.5" />
			</button>
		</div>
	);
}

function WorkspaceRow({
	name,
	onNewSession,
	onArchiveFilter,
}: {
	readonly name: string;
	onNewSession(): void;
	onArchiveFilter(): void;
}): ReactElement {
	return (
		<div className="group/workspace flex h-[34px] items-center gap-1.5 rounded-md px-2">
			<Folder className="size-4 shrink-0 text-foreground-subtle" />
			<span className="min-w-0 flex-1 truncate text-[14px] leading-5">{name}</span>
			<span className="hidden shrink-0 items-center gap-1 group-hover/workspace:flex group-focus-within/workspace:flex">
				<button
					type="button"
					aria-label="在此工作区新建会话"
					title="新建会话"
					onClick={onNewSession}
					className="flex size-4 items-center justify-center text-foreground-subtlest hover:text-foreground"
				>
					<SquarePen className="size-3.5" />
				</button>
				<Menu
					trigger={({ toggle }) => (
						<button
							type="button"
							aria-label="工作区操作"
							title="工作区操作"
							onClick={toggle}
							className="flex size-4 items-center justify-center text-foreground-subtlest hover:text-foreground"
						>
							<Ellipsis className="size-3.5" />
						</button>
					)}
					entries={[
						{ type: "item", key: "rename", label: "重命名（未接入）", disabled: true, onSelect: () => {} },
						{ type: "item", key: "remove", label: "移除工作区（未接入）", disabled: true, onSelect: () => {} },
						{ type: "separator" },
						{ type: "item", key: "archived", label: "切换归档显示", onSelect: onArchiveFilter },
					]}
				/>
			</span>
		</div>
	);
}

function SessionRowView({
	row,
	current,
	running,
	onSwitch,
	onArchive,
	onDelete,
	onRestore,
	onTogglePin,
}: {
	readonly row: SessionRow;
	readonly current: boolean;
	readonly running: boolean;
	onSwitch(): void;
	onArchive(): void;
	onDelete(): void;
	onRestore(): void;
	onTogglePin(): void;
}): ReactElement {
	const entries: MenuEntry[] = row.archived
		? [{ type: "item", key: "restore", label: "恢复", icon: ArchiveRestore, onSelect: onRestore }]
		: [
				{ type: "item", key: "pin", label: row.pinned ? "取消置顶" : "置顶", icon: Pin, onSelect: onTogglePin },
				{
					type: "item",
					key: "rename",
					label: "重命名（未接入）",
					disabled: true,
					onSelect: () => {},
				},
				{
					type: "item",
					key: "fork",
					label: "在新会话中分支（未接入）",
					disabled: true,
					onSelect: () => {},
				},
				{ type: "item", key: "archive", label: "归档", icon: Archive, disabled: current, onSelect: onArchive },
				{
					type: "item",
					key: "delete",
					label: "删除",
					icon: Trash2,
					danger: true,
					disabled: current,
					onSelect: onDelete,
				},
			];

	return (
		<div
			className={cn(
				"group/session flex h-8 items-center rounded-md pl-2 pr-1 text-[14px] leading-5 transition-colors",
				current ? "bg-selected" : "hover:bg-surface-hover",
				row.archived && "text-foreground-subtlest",
			)}
		>
			<span className="flex w-4 shrink-0 items-center justify-center">
				{running ? <StateDot state="ongoing" /> : row.pinned ? <Pin className="size-3 text-foreground-subtlest" /> : null}
			</span>
			<button
				type="button"
				onClick={onSwitch}
				title={row.title}
				className="mx-1 min-w-0 flex-1 truncate text-left"
			>
				{row.title}
			</button>
			{row.archived ? (
				<span className="shrink-0 text-[10px] leading-4 text-foreground-subtlest">已归档</span>
			) : (
				<span className="flex shrink-0 items-center gap-1.5 text-[10px] leading-4 text-foreground-subtlest group-hover/session:hidden group-focus-within/session:hidden">
					<span className="whitespace-nowrap">{relativeTime(row.updatedAt)}</span>
				</span>
			)}
			<span className="hidden shrink-0 items-center group-hover/session:flex group-focus-within/session:flex">
				<Menu
					trigger={({ toggle }) => (
						<button
							type="button"
							aria-label="会话操作"
							title="会话操作"
							onClick={toggle}
							className="flex size-4 items-center justify-center text-foreground-subtlest hover:text-foreground"
						>
							<Ellipsis className="size-3.5" />
						</button>
					)}
					entries={entries}
				/>
			</span>
		</div>
	);
}
