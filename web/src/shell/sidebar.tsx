import {
	Archive,
	Blocks,
	CalendarClock,
	ChevronDown,
	ChevronsDownUp,
	ChevronsUpDown,
	Circle,
	CircleCheck,
	MessageSquarePlus,
	Ellipsis,
	Folder,
	FolderOpen,
	FolderPlus,
	ListChecks,
	ListX,
	Pencil,
	Pin,
	Search,
	Settings,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import { StateDot } from "../components/state-dot.tsx";
import { Button, Dialog, Menu, type MenuEntry } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { desktopBridge } from "../platform.ts";
import type { SessionSummary, WorkspaceSummary } from "../protocol.ts";
import { buildSessionGroups, sidebarSectionVisibility, toggleAllWorkspaceGroups, type SessionRow } from "./session-tree.ts";

export type GlobalPanelId = "schedules";

export interface SidebarProps {
	readonly sessions: readonly SessionSummary[];
	readonly pinned: ReadonlySet<string>;
	readonly currentId: string;
	/** 当前会话还没有任何内容（尚未发送第一条消息），侧栏不为它补行 */
	readonly currentIsDraft: boolean;
	readonly currentWorkspacePath?: string | null;
	readonly running: boolean;
	readonly cwd: string;
	readonly workspaces: readonly WorkspaceSummary[];
	readonly version: string;
	readonly connected: boolean;
	readonly activePanel: GlobalPanelId | undefined;
	/** 搜索框显隐：入口在顶部标题栏，状态上提到应用层，Escape/清除按钮从这里回关 */
	readonly searchOpen: boolean;
	onSearchOpenChange(open: boolean): void;
	onNewSession(workspacePath?: string | null): void;
	onSwitch(session: SessionSummary): void;
	onArchive(id: string): void;
	onDelete(id: string): void;
	onTogglePin(id: string): void;
	onOpenPanel(panel: GlobalPanelId): void;
	/** 侧栏「扩展管理」直接进设置页的扩展分区 */
	onOpenExtensions(): void;
	onOpenSettings(): void;
	onRenameWorkspace?(path: string, name: string): void;
	onRemoveWorkspace?(path: string): void;
	/** 任务重命名：界面层显示名覆盖，服务端标题不动 */
	onRenameSession(id: string, title: string): void;
	/** 批量归档 / 批量删除；服务端会跳过当前会话 */
	onArchiveMany(ids: readonly string[]): void;
	onDeleteMany(ids: readonly string[]): void;
}

/** 侧栏：品牌、新会话、全局面板、工作区浏览区与底部设置。 */
export function Sidebar(props: SidebarProps): ReactElement {
	const [query, setQuery] = useState("");
	const [tasksOpen, setTasksOpen] = useState(true);
	const [spacesOpen, setSpacesOpen] = useState(true);
	const [workspaceOpen, setWorkspaceOpen] = useState<Readonly<Record<string, boolean>>>({});
	const searchInput = useRef<HTMLInputElement | null>(null);
	const groups = buildSessionGroups({
		sessions: props.sessions,
		workspaces: props.workspaces,
		pinned: props.pinned,
		query,
		currentId: props.currentId,
		currentIsDraft: props.currentIsDraft,
		currentCwd: props.cwd,
		currentWorkspacePath: props.currentWorkspacePath,
	});
	const rows = groups.unassigned;

	useEffect(() => {
		if (!props.searchOpen) return;
		searchInput.current?.focus({ preventScroll: true });
	}, [props.searchOpen]);

	const sectionOpen = sidebarSectionVisibility(query.trim().length > 0, tasksOpen, spacesOpen);
	const allWorkspaceGroupsOpen = groups.workspaces.every(({ workspace }) => workspaceOpen[workspace.path] ?? true);
	const onToggleAllWorkspaceGroups = (): void => {
		setWorkspaceOpen((current) => toggleAllWorkspaceGroups(groups.workspaces, current));
	};
	// 工作区「更多」菜单里的重命名弹窗
	const [workspaceRename, setWorkspaceRename] = useState<WorkspaceSummary | undefined>(undefined);
	const [renameValue, setRenameValue] = useState("");
	const bridge = desktopBridge();

	/** 先持久化空间显示名，成功后再更新界面。 */
	const saveRename = (): void => {
		const target = workspaceRename;
		const name = renameValue.trim();
		if (target === undefined || name.length === 0) return;
		const persist = async (): Promise<void> => {
			const ok = (await bridge?.renameWorkspace(target.path, name)) ?? false;
			if (!ok) return;
			props.onRenameWorkspace?.(target.path, name);
			setWorkspaceRename(undefined);
		};
		void persist().catch(() => {});
	};

	const toggleWorkspace = (path: string): void => {
		setWorkspaceOpen((current) => ({ ...current, [path]: !(current[path] ?? true) }));
	};

	// 任务「更多」菜单里的重命名弹窗；记住目标会话，确认时才写覆盖
	const [taskRename, setTaskRename] = useState<{ readonly id: string; readonly value: string } | undefined>(undefined);

	// 批量操作：进入选择模式后行点击改为勾选，底栏统一归档/删除
	const [batchMode, setBatchMode] = useState(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const toggleSelected = (id: string): void => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const exitBatch = (): void => {
		setBatchMode(false);
		setSelected(new Set());
	};
	const archiveSelected = (): void => {
		if (selected.size === 0) return;
		props.onArchiveMany([...selected]);
		exitBatch();
	};
	const deleteSelected = (): void => {
		if (selected.size === 0) return;
		props.onDeleteMany([...selected]);
		exitBatch();
	};


	const renderRows = (items: readonly SessionRow[], emptyMessage?: string): ReactElement | null => {
		if (items.length === 0) {
			return emptyMessage === undefined ? null : (
				<div className="flex flex-col items-center gap-2 px-3 py-6 text-[13px] leading-5 text-foreground-subtlest">
					<Archive className="size-6 text-foreground-subtlest" />
					<span>{emptyMessage}</span>
				</div>
			);
		}
		return (
			<div className="flex flex-col gap-0.5">
				{items.map((row) => (
					<SessionRowView
						key={row.id}
						row={row}
						current={row.id === props.currentId && props.activePanel === undefined}
						running={props.running && row.id === props.currentId}
						batchMode={batchMode}
						selected={selected.has(row.id)}
						onToggleSelect={() => toggleSelected(row.id)}
						onSwitch={() => props.onSwitch(row)}
						onArchive={() => props.onArchive(row.id)}
						onDelete={() => props.onDelete(row.id)}
						onTogglePin={() => props.onTogglePin(row.id)}
						onRename={() => setTaskRename({ id: row.id, value: row.title })}
						onBatch={() => {
							setBatchMode(true);
							setSelected(new Set([row.id]));
						}}
						onOpenFolder={
							bridge === undefined
								? undefined
								: () => bridge.openWorkspaceFolder((row.workspacePath ?? row.cwd) || props.cwd)
						}
					/>
				))}
			</div>
		);
	};

	return (
		<aside className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar px-3 pt-1.5 pb-1.5 text-foreground">
			<div className="flex h-10 shrink-0 items-center gap-2 pl-1">
				<BrandMark size={24} />
				<span className="min-w-0 truncate text-[18px] leading-6 font-semibold tracking-[0.04em]">Reins</span>
				{props.version.length === 0 ? null : (
					<span className="ml-auto shrink-0 font-mono text-[10px] leading-4 text-foreground-subtlest">
						v{props.version}
					</span>
				)}
			</div>

			<nav className="mt-2 mb-2 flex shrink-0 flex-col gap-0.5">
				<PanelRow
					icon={<MessageSquarePlus className="size-4" />}
					label="新建任务"
					hint="Ctrl N"
					active={false}
					onClick={() => props.onNewSession(null)}
				/>
				<PanelRow
					icon={<Blocks className="size-4" />}
					label="扩展管理"
					active={false}
					onClick={props.onOpenExtensions}
				/>
				<PanelRow
					icon={<CalendarClock className="size-4" />}
					label="定时任务"
					active={props.activePanel === "schedules"}
					onClick={() => props.onOpenPanel("schedules")}
				/>
			</nav>

			<div className="flex min-h-0 flex-1 flex-col">
				{/* 搜索入口移到了顶部标题栏；这里只在搜索时呈现输入行，平时整行消失 */}
				{props.searchOpen ? (
					<div className="mb-1 flex h-9 shrink-0 items-center gap-1 pl-1">
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
									props.onSearchOpenChange(false);
								}}
								placeholder="搜索任务"
								aria-label="搜索任务"
								className="min-w-0 flex-1 bg-transparent px-1 text-[13px] leading-[18px] outline-none placeholder:text-foreground-subtlest"
							/>
							<button
								type="button"
								aria-label="清除搜索"
								onClick={() => {
									setQuery("");
									props.onSearchOpenChange(false);
								}}
								className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover"
							>
								<X className="size-3" />
							</button>
						</div>
					</div>
				) : null}

				<div className="min-h-0 flex-1 overflow-y-auto pb-4">
					<SectionHeader
						label="任务"
						count={rows.length}
						open={sectionOpen.tasks}
						onToggle={() => setTasksOpen((value) => !value)}
					/>
					<div className="sidebar-section-motion" data-open={sectionOpen.tasks || undefined}>
						<div className="sidebar-section-content">{renderRows(rows, query.length > 0 ? "没有匹配的任务" : "暂无任务")}</div>
					</div>

					<SectionHeader
						label="空间"
						count={props.workspaces.length}
						open={sectionOpen.spaces}
						onToggle={() => setSpacesOpen((value) => !value)}
						addLabel="添加项目"
						onAdd={() => {
							void bridge?.chooseWorkspace();
						}}
						addDisabled={bridge === undefined}
						action={
							/* 折叠空间下所有项目：排在添加按钮之前，与「+」同款 hover 显隐 */
							<button
								type="button"
								aria-label={allWorkspaceGroupsOpen ? "收起所有分组" : "展开所有分组"}
								title={allWorkspaceGroupsOpen ? "收起所有分组" : "展开所有分组"}
								onClick={onToggleAllWorkspaceGroups}
								className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtlest opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover/section:opacity-100 group-has-focus-visible/section:opacity-100"
							>
								{allWorkspaceGroupsOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
							</button>
						}
					/>
					<div className="sidebar-section-motion" data-open={sectionOpen.spaces || undefined}>
						<div className="sidebar-section-content">
							{groups.workspaces.map(({ workspace, rows: workspaceRows }) => {
										const isOpen = query.trim().length > 0 || (workspaceOpen[workspace.path] ?? true);
								return (
									<div key={workspace.path}>
										<WorkspaceRow
											workspace={workspace}
											open={isOpen}
											onToggle={() => toggleWorkspace(workspace.path)}
											onNewSession={() => props.onNewSession(workspace.path)}
											onOpenFolder={bridge === undefined ? undefined : () => bridge.openWorkspaceFolder(workspace.path)}
											onRename={bridge === undefined ? undefined : () => {
												setRenameValue(workspace.name);
												setWorkspaceRename(workspace);
											}}
											onRemove={bridge === undefined ? undefined : () => {
												void bridge.removeWorkspace(workspace.path).then((removed) => {
													if (removed) props.onRemoveWorkspace?.(workspace.path);
												}).catch(() => {});
											}}
										/>
										<div className="sidebar-section-motion" data-open={sectionOpen.spaces && isOpen || undefined}>
											<div className="sidebar-section-content">{renderRows(workspaceRows)}</div>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</div>
			</div>

			{batchMode ? (
				<div className="mb-1 flex h-9 shrink-0 items-center gap-1 rounded-md border-[0.5px] border-border bg-card px-2">
					<span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground-subtle">
						已选 {selected.size} 项
					</span>
					<button
						type="button"
						disabled={selected.size === 0}
						onClick={archiveSelected}
						className="flex h-7 items-center gap-1 rounded-sm px-2 text-[13px] leading-5 text-foreground-subtle transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40"
					>
						<Archive className="size-3.5" />
						归档
					</button>
					<button
						type="button"
						disabled={selected.size === 0}
						onClick={deleteSelected}
						className="flex h-7 items-center gap-1 rounded-sm px-2 text-[13px] leading-5 text-destructive transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40"
					>
						<Trash2 className="size-3.5" />
						删除
					</button>
					<button
						type="button"
						onClick={exitBatch}
						className="flex h-7 items-center rounded-sm px-2 text-[13px] leading-5 text-foreground-subtle transition-colors hover:bg-surface-hover"
					>
						取消
					</button>
				</div>
			) : null}

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
				open={workspaceRename !== undefined}
				onClose={() => setWorkspaceRename(undefined)}
				title="重命名项目"
				footer={
					<>
							<Button variant="outline" onClick={() => setWorkspaceRename(undefined)}>
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
					placeholder="项目名称"
					aria-label="项目名称"
					autoFocus
					className="h-9 w-full rounded-md border-[0.5px] border-input-border bg-input px-3 text-[14px] leading-[22px] outline-none focus:border-input-border-focused"
				/>
			</Dialog>

			<Dialog
				open={taskRename !== undefined}
				onClose={() => setTaskRename(undefined)}
				title="重命名任务"
				footer={
					<>
						<Button variant="outline" onClick={() => setTaskRename(undefined)}>
							取消
						</Button>
						<Button
							variant="primary"
							disabled={taskRename === undefined || taskRename.value.trim().length === 0}
							onClick={() => {
								if (taskRename === undefined) return;
								const title = taskRename.value.trim();
								if (title.length === 0) return;
								props.onRenameSession(taskRename.id, title);
								setTaskRename(undefined);
							}}
						>
							保存
						</Button>
					</>
				}
			>
				<input
					value={taskRename?.value ?? ""}
					onChange={(event) => setTaskRename((current) => (current === undefined ? current : { ...current, value: event.target.value }))}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || taskRename === undefined) return;
						const title = taskRename.value.trim();
						if (title.length === 0) return;
						props.onRenameSession(taskRename.id, title);
						setTaskRename(undefined);
					}}
					placeholder="任务名称"
					aria-label="任务名称"
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
	// 属性式函数类型：事件回调必须显式包一层，避免处理程序把点击事件当业务参数收走
	readonly onClick: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={cn(
				// 图标落 20px 首列、文字落 40px 内容列（与文件夹图标、未绑定任务标题同列）
				"group/panel flex min-h-9 items-center gap-1 rounded-md px-2 py-[7px] text-left text-[14px] leading-[22px] transition-colors hover:bg-surface-hover",
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
 * 两段共用一套形态（任务 / 空间）：任务装会话，空间装工作区文件夹。
 */
function SectionHeader({
	label,
	count,
	open,
	onToggle,
	addLabel,
	addIcon,
	onAdd,
	addDisabled,
	action,
}: {
	readonly label: string;
	readonly count: number;
	readonly open: boolean;
	onToggle(): void;
	readonly addLabel?: string;
	readonly addIcon?: ReactElement;
	onAdd?(): void;
	readonly addDisabled?: boolean;
	/** 段标题右侧、添加按钮之前的附加动作（如折叠所有分组）；显隐由调用方自行控制 */
	readonly action?: ReactElement;
}): ReactElement {
	return (
		<div className="group/section sticky top-0 z-10 flex h-[30px] items-center gap-1 rounded-md bg-sidebar px-2">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex h-5 min-w-0 flex-1 items-center gap-1.5 text-left leading-none"
			>
				{/* 标题和计数紧随标题排列，折叠箭头跟在计数之后；仅交互时显现 */}
				<span className="truncate text-[12px] leading-4 font-semibold text-foreground-subtle">
					{label}
					{count > 0 ? <span className="text-foreground-subtlest">({count})</span> : null}
				</span>
				<ChevronDown
					className={cn(
						"size-3.5 shrink-0 text-foreground-subtlest opacity-0 transition-[transform,opacity] group-hover/section:opacity-100 group-has-focus-visible/section:opacity-100",
						!open && "-rotate-90",
					)}
				/>
			</button>
			{action}
			{addLabel === undefined || onAdd === undefined ? null : (
				<button
					type="button"
					aria-label={addLabel}
					title={addLabel}
					disabled={addDisabled}
					onClick={onAdd}
					className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtlest opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover/section:opacity-100 group-has-focus-visible/section:opacity-100 disabled:hidden"
				>
					{addIcon ?? <FolderPlus className="size-3.5" />}
				</button>
			)}
		</div>
	);
}

/**
 * 空间段里的一行工作区。
 *
 * 文件夹图标与段标题同列，开/合状态用 FolderOpen/Folder 表达，项目标题紧随其后；
 * 行尾 hover 出新建任务与更多菜单；
 * 打开文件夹/重命名/移除只在桌面壳里有实体动作，浏览器里省略。
 */
function WorkspaceRow({
	workspace,
	open,
	onToggle,
	onNewSession,
	onOpenFolder,
	onRename,
	onRemove,
}: {
	readonly workspace: WorkspaceSummary;
	readonly open: boolean;
	onToggle(): void;
	onNewSession(): void;
	readonly onOpenFolder?: () => void;
	readonly onRename?: () => void;
	readonly onRemove?: () => void;
}): ReactElement {
	const entries: MenuEntry[] = [
		...(onOpenFolder === undefined ? [] : [{ type: "item" as const, key: "open", label: "打开文件夹", icon: FolderOpen, onSelect: onOpenFolder }]),
		...(onRename === undefined ? [] : [{ type: "item" as const, key: "rename", label: "重命名", icon: Pencil, onSelect: onRename }]),
		...(onRemove === undefined ? [] : [{ type: "item" as const, key: "remove", label: "从列表中移除", icon: ListX, danger: true, onSelect: onRemove }]),
	];

	return (
		<div className="group/workspace flex h-[34px] items-center gap-1.5 rounded-md pr-2 pl-2 hover:bg-surface-hover">
			<button
				type="button"
				aria-expanded={open}
				aria-label={`${open ? "收起" : "展开"}项目 ${workspace.name}`}
				onClick={onToggle}
				className="flex min-w-0 flex-1 items-center gap-1 text-left"
			>
				{/* 开合状态由目录图标本身表达：展开是打开的文件夹，折叠是合上的 */}
				{open ? (
					<FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
				) : (
					<Folder className="size-4 shrink-0 text-foreground-subtle" />
				)}
				<span className="min-w-0 flex-1 truncate text-[14px] leading-5">{workspace.name}</span>
			</button>
			<span className="hidden shrink-0 items-center gap-0.5 group-hover/workspace:flex group-has-focus-visible/workspace:flex group-has-[[data-menu-open]]/workspace:flex">
				<button
					type="button"
					aria-label={`在 ${workspace.name} 中新建任务`}
					title="新建任务"
					onClick={onNewSession}
					className="flex size-5 items-center justify-center rounded-sm text-foreground-subtlest hover:bg-surface-strong hover:text-foreground"
				>
					<MessageSquarePlus className="size-3.5" />
				</button>
				<Menu
					trigger={({ toggle }) => (
						<button
							type="button"
							aria-label="项目操作"
							title="项目操作"
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

/**
 * 任务行。
 *
 * 普通模式下 hover 出「更多」菜单（置顶/重命名 ─ 打开文件夹/批量操作 ─ 归档/删除）；
 * 批量模式下整行变成勾选框，点行即选中/取消，菜单收起，统一动作由底栏发起。
 */
function SessionRowView({
	row,
	current,
	running,
	batchMode,
	selected,
	onToggleSelect,
	onSwitch,
	onArchive,
	onDelete,
	onTogglePin,
	onRename,
	onBatch,
	onOpenFolder,
}: {
	readonly row: SessionRow;
	readonly current: boolean;
	readonly running: boolean;
	readonly batchMode: boolean;
	readonly selected: boolean;
	onToggleSelect(): void;
	onSwitch(): void;
	onArchive(): void;
	onDelete(): void;
	onTogglePin(): void;
	onRename(): void;
	onBatch(): void;
	readonly onOpenFolder?: () => void;
}): ReactElement {
	const entries: MenuEntry[] = [
		{ type: "item", key: "pin", label: row.pinned ? "取消置顶" : "置顶", icon: Pin, onSelect: onTogglePin },
		{ type: "item", key: "rename", label: "重命名", icon: Pencil, onSelect: onRename },
		{ type: "separator" },
		...(onOpenFolder === undefined
			? []
			: [{ type: "item" as const, key: "open", label: "打开文件夹", icon: FolderOpen, onSelect: onOpenFolder }]),
		{ type: "item", key: "batch", label: "批量操作", icon: ListChecks, onSelect: onBatch },
		{ type: "separator" },
		{ type: "item", key: "archive", label: "归档", icon: Archive, disabled: current, onSelect: onArchive },
		{ type: "item", key: "delete", label: "删除任务", icon: Trash2, danger: true, disabled: current, onSelect: onDelete },
	];

	if (batchMode) {
		return (
			<button
				type="button"
				onClick={onToggleSelect}
				aria-pressed={selected}
				title={row.title}
				className={cn(
					"flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] leading-5 transition-colors",
					selected ? "bg-selected" : "hover:bg-surface-hover",
				)}
			>
				{selected ? (
					<CircleCheck className="size-4 shrink-0 text-(--accent)" />
				) : (
					<Circle className="size-4 shrink-0 text-foreground-subtlest" />
				)}
				<span className="min-w-0 flex-1 truncate">{row.title}</span>
				<span className="shrink-0 text-[10px] leading-4 text-foreground-subtlest">{relativeTime(row.updatedAt)}</span>
			</button>
		);
	}

	return (
		<div
			className={cn(
				"group/session flex h-8 items-center rounded-md pl-2 pr-1 text-[14px] leading-5 transition-colors",
				current ? "bg-selected" : "hover:bg-surface-hover",
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
			<span className="flex shrink-0 items-center gap-1.5 text-[10px] leading-4 text-foreground-subtlest group-hover/session:hidden group-has-focus-visible/session:hidden group-has-[[data-menu-open]]/session:hidden">
				<span className="whitespace-nowrap">{relativeTime(row.updatedAt)}</span>
			</span>
			<span className="hidden shrink-0 items-center group-hover/session:flex group-has-focus-visible/session:flex group-has-[[data-menu-open]]/session:flex">
				<Menu
					trigger={({ toggle }) => (
						<button
							type="button"
							aria-label="任务操作"
							title="任务操作"
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
