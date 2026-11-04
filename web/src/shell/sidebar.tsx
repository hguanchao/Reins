import {
	Archive,
	ArchiveRestore,
	Blocks,
	CalendarClock,
	ChevronDown,
	ChevronsDownUp,
	ChevronsUpDown,
	CirclePlus,
	Ellipsis,
	Folder,
	FolderOpen,
	FolderPlus,
	ListX,
	Pencil,
	Pin,
	Search,
	Settings,
	SlidersHorizontal,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import { StateDot } from "../components/state-dot.tsx";
import { Button, Dialog, Menu, type MenuEntry } from "../components/ui/index.ts";
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
	/** 工作区在侧栏里的显示名；桌面端改名后由壳回报，浏览器回落到目录名 */
	readonly workspaceLabel: string | undefined;
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
	/** 侧栏里改了工作区显示名（桌面壳持久化；浏览器不回调） */
	onRenameWorkspace?(name: string): void;
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
	// 两段都展开时才算「全展开」：一键收起；其余状态一键全展开
	const allOpen = sectionOpen.tasks && sectionOpen.spaces;
	const toggleAllSections = (): void => {
		setTasksOpen(!allOpen);
		setSpacesOpen(!allOpen);
	};
	// 工作区「更多」菜单里的重命名弹窗
	const [renameOpen, setRenameOpen] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const bridge = desktopBridge();
	const workspaceDisplay = props.workspaceLabel ?? (workspaceName(props.cwd) || "Reins");

	/** 保存重命名:名字先落到桌面壳(持久化),壳确认后界面才跟着改名。 */
	const saveRename = (): void => {
		const name = renameValue.trim();
		if (name.length === 0) return;
		const persist = async (): Promise<void> => {
			const ok = (await bridge?.renameWorkspace(name)) ?? false;
			if (!ok) return;
			props.onRenameWorkspace?.(name);
			setRenameOpen(false);
		};
		void persist().catch(() => {});
	};


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

			<nav className="mt-2 mb-2 flex shrink-0 flex-col gap-0.5">
				<PanelRow
					icon={<CirclePlus className="size-4" />}
					label="新建任务"
					hint="Ctrl N"
					active={false}
					onClick={props.onNewSession}
				/>
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
								aria-label={allOpen ? "收起所有工作区" : "展开所有工作区"}
								title={allOpen ? "收起所有工作区" : "展开所有工作区"}
								className="size-7 rounded-sm text-foreground-subtle hover:bg-surface-hover"
								onClick={toggleAllSections}
							>
								{allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
							</Button>
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
								name={workspaceDisplay}
								onNewSession={props.onNewSession}
								onOpenFolder={
									bridge === undefined
										? undefined
										: () => {
												bridge.openWorkspaceFolder();
											}
								}
								onRename={
									bridge === undefined
										? undefined
										: () => {
												setRenameValue(workspaceDisplay);
												setRenameOpen(true);
											}
								}
								onRemove={
									bridge === undefined
										? undefined
										: () => {
												void bridge.chooseWorkspace();
											}
								}
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

			<Dialog
				open={renameOpen}
				onClose={() => setRenameOpen(false)}
				title="重命名空间"
				footer={
					<>
						<Button variant="outline" onClick={() => setRenameOpen(false)}>
							取消
						</Button>
						<Button variant="primary" disabled={renameValue.trim().length === 0} onClick={saveRename}>
							保存
						</Button>
					</>
				}
			>
				<input
					value={renameValue}
					onChange={(event) => setRenameValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") saveRename();
					}}
					placeholder="空间名称"
					aria-label="空间名称"
					autoFocus
					className="h-9 w-full rounded-md border-[0.5px] border-input-border bg-input px-3 text-[14px] leading-[22px] outline-none focus:border-input-border-focused"
				/>
			</Dialog>
		</aside>
	);
}

function PanelRow({
	icon,
	label,
	hint,
	active,
	onClick,
}: {
	readonly icon: ReactElement;
	readonly label: string;
	/** 行尾的浅色小字提示（如快捷键）；hover 时出现 */
	readonly hint?: string;
	readonly active: boolean;
	onClick(): void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={cn(
				"group/panel mx-0.5 flex min-h-9 items-center gap-2 rounded-md px-2 py-[7px] text-left text-[14px] leading-[22px] transition-colors hover:bg-surface-hover",
				active && "bg-selected",
			)}
		>
			<span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{hint === undefined ? null : (
				<span className="shrink-0 text-[12px] leading-4 font-normal text-foreground-subtlest opacity-0 transition-opacity group-hover/panel:opacity-100">
					{hint}
				</span>
			)}
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

/**
 * 空间段里的一行工作区。
 *
 * 行首图标与「空间」标题左缘对齐（同为 px-2 网格），行尾 hover 出新建任务与更多菜单；
 * 打开文件夹/重命名/移除只在桌面壳里有实体动作，浏览器里省略。
 */
function WorkspaceRow({
	name,
	onNewSession,
	onOpenFolder,
	onRename,
	onRemove,
	onArchiveFilter,
}: {
	readonly name: string;
	onNewSession(): void;
	readonly onOpenFolder?: () => void;
	readonly onRename?: () => void;
	readonly onRemove?: () => void;
	onArchiveFilter(): void;
}): ReactElement {
	const entries: MenuEntry[] = [
		...(onOpenFolder === undefined ? [] : [{ type: "item" as const, key: "open", label: "打开文件夹", icon: FolderOpen, onSelect: onOpenFolder }]),
		...(onRename === undefined ? [] : [{ type: "item" as const, key: "rename", label: "重命名", icon: Pencil, onSelect: onRename }]),
		...(onRemove === undefined ? [] : [{ type: "item" as const, key: "remove", label: "从列表中移除", icon: ListX, danger: true, onSelect: onRemove }]),
		{ type: "separator" as const },
		{ type: "item" as const, key: "archived", label: "切换归档显示", onSelect: onArchiveFilter },
	];

	return (
		// 行首图标与「空间」二字对齐：标题里折叠箭头 + 间距的进深，用左内边距补齐
		<div className="group/workspace flex h-[34px] items-center gap-1.5 rounded-md pr-2 pl-7 hover:bg-surface-hover">
			<Folder className="size-4 shrink-0 text-foreground-subtle" />
			<span className="min-w-0 flex-1 truncate text-[14px] leading-5">{name}</span>
			<span className="hidden shrink-0 items-center gap-0.5 group-hover/workspace:flex group-focus-within/workspace:flex">
				<button
					type="button"
					aria-label="在此工作区新建任务"
					title="新建任务"
					onClick={onNewSession}
					className="flex size-5 items-center justify-center rounded-sm text-foreground-subtlest hover:bg-surface-strong hover:text-foreground"
				>
					<CirclePlus className="size-3.5" />
				</button>
				<Menu
					trigger={({ toggle }) => (
						<button
							type="button"
							aria-label="空间操作"
							title="空间操作"
							onClick={toggle}
							className="flex size-5 items-center justify-center rounded-sm text-foreground-subtlest hover:bg-surface-strong hover:text-foreground"
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
