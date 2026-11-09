import {
	Archive,
	Blocks,
	CalendarClock,
	ChevronRight,
	CircleAlert,
	CircleSlash,
	Ellipsis,
	EyeOff,
	Folder,
	FolderOpen,
	LoaderCircle,
	Pencil,
	Pin,
	Plus,
	Search,
	Settings,
	Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { Dialog, Menu, toast, type MenuEntry } from "../components/ui/index.ts";
import { relativeTime } from "../lib/format.ts";
import { desktopBridge } from "../platform.ts";
import type { SessionSummary, WorkspaceSummary } from "../protocol.ts";
import { BUCKET_LABELS, bucketRows, buildSessionGroups, type SessionRow } from "./session-tree.ts";

import type { GlobalPanelId } from "../panels/types.ts";

export type { GlobalPanelId };

export interface SidebarProps {
	readonly sessions: readonly SessionSummary[];
	readonly pinned: ReadonlySet<string>;
	readonly currentId: string;
	/** 当前会话还没有任何内容（尚未发送第一条消息），侧栏不为它补行 */
	readonly currentIsDraft: boolean;
	readonly currentWorkspacePath?: string | null;
	readonly running: boolean;
	/** 当前回合停在审批上：会话行显示感叹圆 */
	readonly waiting: boolean;
	readonly cwd: string;
	readonly workspaces: readonly WorkspaceSummary[];
	readonly version: string;
	readonly activePanel: GlobalPanelId | undefined;
	readonly searchOpen: boolean;
	onSearchOpenChange(open: boolean): void;
	onNewSession(workspacePath?: string | null): void;
	onSwitch(session: SessionSummary): void;
	onArchive(id: string): void;
	onDelete(id: string): void;
	onTogglePin(id: string): void;
	onOpenPanel(panel: GlobalPanelId): void;
	onOpenExtensions(): void;
	onOpenSettings(): void;
	onRenameWorkspace?(path: string, name: string): void;
	/** 从侧栏移除：隐藏登记条目，任务全部保留 */
	onHideWorkspace?(path: string): void;
	/** 删除项目：连同名下任务永久移除，调用方需自行确认 */
	onRemoveWorkspace?(path: string): void;
	onRenameSession(id: string, title: string): void;
}

/**
 * 侧栏。
 *
 * 两大区按归属分层：「任务」放未绑定项目的会话，按 进行中 / 今天 / 昨天 / 更早 分小节；
 * 「工作区」放绑定了项目的会话，按所属项目分组、可整组折叠。一个会话只会出现在其中一处。
 * 侧栏不显示计数：计数会给每一行都多加一个要读的数字，而折叠已经表达了「这里有多少东西」。
 */
export function Sidebar(props: SidebarProps): ReactElement {
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
	const searchInput = useRef<HTMLInputElement | null>(null);
	const bridge = desktopBridge();

	const groups = buildSessionGroups({
		sessions: props.sessions,
		workspaces: props.workspaces,
		pinned: props.pinned,
		query,
		currentId: props.currentId,
		currentIsDraft: props.currentIsDraft,
		currentCwd: props.cwd,
		currentWorkspacePath: props.currentWorkspacePath,
		running: props.running,
	});
	const buckets = bucketRows(groups.unassigned, { currentId: props.currentId, running: props.running });
	const searching = query.trim().length > 0;

	useEffect(() => {
		if (!props.searchOpen) return;
		searchInput.current?.focus({ preventScroll: true });
	}, [props.searchOpen]);

	const [workspaceRename, setWorkspaceRename] = useState<WorkspaceSummary | undefined>(undefined);
	const [workspaceDelete, setWorkspaceDelete] = useState<WorkspaceSummary | undefined>(undefined);
	const [renameValue, setRenameValue] = useState("");
	const [taskRename, setTaskRename] = useState<{ readonly id: string; readonly value: string } | undefined>(undefined);

	const saveWorkspaceRename = (): void => {
		const target = workspaceRename;
		const name = renameValue.trim();
		if (target === undefined || name.length === 0) return;
		void (async () => {
			const ok = (await bridge?.renameWorkspace(target.path, name)) ?? false;
			// 内核会在空名、超长或落盘失败时返回 false；此处必须给反馈，否则「保存」看起来毫无反应
			if (!ok) {
				toast("工作区名称保存失败：名称需为 1–60 个字符，且配置文件可写", "error");
				return;
			}
			props.onRenameWorkspace?.(target.path, name);
			setWorkspaceRename(undefined);
		})().catch(() => toast("工作区名称保存失败，请稍后重试", "error"));
	};

	const renderRow = (row: SessionRow): ReactElement => (
		<SessionRowView
			key={row.id}
			row={row}
			current={row.id === props.currentId && props.activePanel === undefined}
			running={props.running && row.id === props.currentId}
			waiting={props.waiting && row.id === props.currentId}
			onSwitch={() => props.onSwitch(row)}
			onArchive={() => props.onArchive(row.id)}
			onDelete={() => props.onDelete(row.id)}
			onTogglePin={() => props.onTogglePin(row.id)}
			onRename={() => setTaskRename({ id: row.id, value: row.title })}
			onOpenFolder={
				bridge === undefined
					? undefined
					: () => bridge.openWorkspaceFolder((row.workspacePath ?? row.cwd) || props.cwd)
			}
		/>
	);

	return (
		<aside className="side">
			<div className="side-top">
				<div className="side-brand">
					<div className="brandmark">R</div>
					<span className="bn">Reins</span>
					{props.version.length === 0 ? null : <span className="bv">v{props.version}</span>}
				</div>

				<button type="button" className="btn-new" onClick={() => props.onNewSession(null)}>
					<Plus className="ic ic-14" />
					<span>新建任务</span>
					<span className="k">Ctrl N</span>
				</button>

				<div className="side-search">
					<Search className="ic ic-14" />
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
					/>
				</div>

				<div className="side-nav">
					<button
						type="button"
						className={`nav-row${props.activePanel === "schedules" ? " is-on" : ""}`}
						onClick={() => props.onOpenPanel("schedules")}
					>
						<CalendarClock className="ic ic-14" />
						<span>定时任务</span>
					</button>
					<button type="button" className="nav-row" onClick={props.onOpenExtensions}>
						<Blocks className="ic ic-14" />
						<span>扩展管理</span>
					</button>
				</div>
			</div>

			<div className="side-scroll">
				<div className="side-zone">任务</div>
				{buckets.length === 0 ? (
					<div className="side-sub" style={{ color: "var(--ink-4)", letterSpacing: 0 }}>
						{searching ? "没有匹配的任务" : "暂无任务"}
					</div>
				) : (
					buckets.map((group) => (
						<div key={group.bucket}>
							<div className="side-sub">{BUCKET_LABELS[group.bucket]}</div>
							{group.rows.map(renderRow)}
						</div>
					))
				)}

				<div className="side-zone">工作区</div>

				{groups.workspaces.length === 0 ? (
					<div className="side-sub" style={{ color: "var(--ink-4)", letterSpacing: 0 }}>
						暂无工作区
					</div>
				) : (
					groups.workspaces.map(({ workspace, rows }) => {
						const open = searching || !(collapsed[workspace.path] ?? false);
						const entries: MenuEntry[] = [
							{ type: "item", key: "new", label: "新建任务", icon: Plus, onSelect: () => props.onNewSession(workspace.path) },
							...(bridge === undefined
								? []
								: [
										{
											type: "item" as const,
											key: "reveal",
											label: "在资源管理器中显示",
											icon: FolderOpen,
											onSelect: () => bridge.openWorkspaceFolder(workspace.path),
										},
										{
											type: "item" as const,
											key: "rename",
											label: "重命名",
											icon: Pencil,
											onSelect: () => {
												setRenameValue(workspace.name);
												setWorkspaceRename(workspace);
											},
										},
										{ type: "separator" as const },
										{
											type: "item" as const,
											key: "hide",
											label: "从侧栏移除",
											icon: EyeOff,
											onSelect: () => props.onHideWorkspace?.(workspace.path),
										},
										{
											type: "item" as const,
											key: "delete",
											label: "删除项目…",
											icon: Trash2,
											danger: true,
											onSelect: () => setWorkspaceDelete(workspace),
										},
									]),
						];

						return (
							<div key={workspace.path} className="side-sec" style={{ marginTop: 2 }}>
								<div className="side-ws-head">
									<button
										type="button"
										aria-expanded={open}
										aria-label={`${open ? "收起" : "展开"}工作区 ${workspace.name}`}
										onClick={() =>
											setCollapsed((current) => ({ ...current, [workspace.path]: !(current[workspace.path] ?? false) }))
										}
										/* 按钮的 UA 默认 text-align:center 会把拉伸后的组名居中，demo 里名字靠左 */
										style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1, textAlign: "left" }}
									>
										<ChevronRight className={`ic ic-12${open ? " open" : ""}`} />
										{open ? <FolderOpen className="ic ic-14" /> : <Folder className="ic ic-14" />}
										<span className="n">{workspace.name}</span>
									</button>
									<Menu
										align="end"
										entries={entries}
										trigger={({ toggle, open: menuOpen }) => (
											<button
												type="button"
												className="ws-more"
												title="工作区操作"
												aria-haspopup="menu"
												aria-expanded={menuOpen}
												onClick={toggle}
											>
												<Ellipsis className="ic ic-12" />
											</button>
										)}
									/>
								</div>
								{open ? (
									rows.length === 0 ? (
										/* 28 = 任务行标题列（8 内衬 + 12 状态位 + 8 间隙），空态文字与任务标题同列 */
										<div className="side-sub" style={{ paddingLeft: 28, color: "var(--ink-4)", letterSpacing: 0 }}>
											暂无任务
										</div>
									) : (
										rows.map(renderRow)
									)
								) : null}
							</div>
						);
					})
				)}
			</div>

			<div className="side-foot">
				<div className="user">
					<span className="av">C</span>
					<span className="min-w-0 truncate">本地模式</span>
				</div>
				<button type="button" className="fbtn" aria-label="设置" title="设置 (Ctrl ,)" onClick={props.onOpenSettings}>
					<Settings className="ic ic-14" />
				</button>
			</div>

			<Dialog
				open={workspaceRename !== undefined}
				onClose={() => setWorkspaceRename(undefined)}
				title="重命名工作区"
				footer={
					<>
						<button type="button" className="b b-line" onClick={() => setWorkspaceRename(undefined)}>
							取消
						</button>
						<button
							type="button"
							className="b b-solid"
							disabled={renameValue.trim().length === 0}
							onClick={saveWorkspaceRename}
						>
							保存
						</button>
					</>
				}
			>
				<input
					value={renameValue}
					onChange={(event) => setRenameValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") saveWorkspaceRename();
					}}
					placeholder="工作区名称"
					aria-label="工作区名称"
					autoFocus
					className="form-input"
				/>
			</Dialog>

			<Dialog
				open={workspaceDelete !== undefined}
				onClose={() => setWorkspaceDelete(undefined)}
				title="永久删除项目"
				footer={
					<>
						<button type="button" className="b b-line" onClick={() => setWorkspaceDelete(undefined)}>
							取消
						</button>
						<button
							type="button"
							className="b b-danger"
							onClick={() => {
								if (workspaceDelete === undefined) return;
								props.onRemoveWorkspace?.(workspaceDelete.path);
								setWorkspaceDelete(undefined);
							}}
						>
							永久删除
						</button>
					</>
				}
			>
				<p style={{ margin: 0 }}>
					「{workspaceDelete?.name ?? "未命名项目"}」名下的活动任务与已归档任务会一并永久删除，不能恢复。
				</p>
				<p style={{ margin: 0, color: "var(--ink-3)" }}>
					只想从侧栏收起来、保留任务，请改用「从侧栏移除」。
				</p>
			</Dialog>

			<Dialog
				open={taskRename !== undefined}
				onClose={() => setTaskRename(undefined)}
				title="重命名任务"
				footer={
					<>
						<button type="button" className="b b-line" onClick={() => setTaskRename(undefined)}>
							取消
						</button>
						<button
							type="button"
							className="b b-solid"
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
						</button>
					</>
				}
			>
				<input
					value={taskRename?.value ?? ""}
					onChange={(event) =>
						setTaskRename((current) => (current === undefined ? current : { ...current, value: event.target.value }))
					}
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
					className="form-input"
				/>
			</Dialog>
		</aside>
	);
}

/** 会话状态：形状 + 明度，不靠颜色。已完成与空闲不显示任何标识，留白即「无事」。 */
function StateMark({
	running,
	waiting,
	aborted,
}: {
	readonly running: boolean;
	readonly waiting: boolean;
	readonly aborted: boolean;
}): ReactElement {
	if (running) {
		return (
			<span className="st st-run">
				<LoaderCircle className="ic" />
			</span>
		);
	}
	if (waiting) {
		return (
			<span className="st st-wait">
				<CircleAlert className="ic" />
			</span>
		);
	}
	if (aborted) {
		return (
			<span className="st st-stop">
				<CircleSlash className="ic" />
			</span>
		);
	}
	return <span className="st st-none" />;
}

/**
 * 任务行。
 *
 * 悬停出「置顶 + 更多」两枚小钮，时间戳原位淡出；菜单打开期间行保持选中、按钮不消失。
 * 已完成与空闲不带状态标识：一列灰对勾只是噪音。
 */
function SessionRowView({
	row,
	current,
	running,
	waiting,
	onSwitch,
	onArchive,
	onDelete,
	onTogglePin,
	onRename,
	onOpenFolder,
}: {
	readonly row: SessionRow;
	readonly current: boolean;
	readonly running: boolean;
	readonly waiting: boolean;
	onSwitch(): void;
	onArchive(): void;
	onDelete(): void;
	onTogglePin(): void;
	onRename(): void;
	readonly onOpenFolder?: () => void;
}): ReactElement {
	const entries: MenuEntry[] = [
		{ type: "item", key: "rename", label: "重命名", hint: "F2", icon: Pencil, onSelect: onRename },
		...(onOpenFolder === undefined
			? []
			: [
					{
						type: "item" as const,
						key: "open",
						label: "在资源管理器中显示",
						icon: FolderOpen,
						onSelect: onOpenFolder,
					},
				]),
		{ type: "separator" },
		{ type: "item", key: "archive", label: "归档", icon: Archive, disabled: current, onSelect: onArchive },
		{
			type: "item",
			key: "delete",
			label: "删除此任务",
			icon: Trash2,
			danger: true,
			disabled: current,
			onSelect: onDelete,
		},
	];

	return (
		<div className="sess" aria-current={current || undefined}>
			<StateMark running={running} waiting={waiting} aborted={false} />
			<button type="button" onClick={onSwitch} onDoubleClick={onRename} title={row.title} className="tt">
				{row.title}
			</button>
			<span className="tm">{relativeTime(row.updatedAt)}</span>
			<span className="hover-actions">
				<button
					type="button"
					aria-label={row.pinned ? "取消置顶" : "置顶"}
					title={row.pinned ? "取消置顶" : "置顶"}
					onClick={onTogglePin}
				>
					<Pin className="ic ic-12" />
				</button>
				<Menu
					align="end"
					entries={entries}
					trigger={({ toggle, open }) => (
						<button
							type="button"
							aria-label="任务操作"
							title="任务操作"
							aria-haspopup="menu"
							aria-expanded={open}
							onClick={toggle}
						>
							<Ellipsis className="ic ic-12" />
						</button>
					)}
				/>
			</span>
		</div>
	);
}
