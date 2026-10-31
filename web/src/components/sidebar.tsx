import {
	Archive,
	ArchiveRestore,
	Bell,
	Check,
	ChevronDown,
	ChevronRight,
	Folder,
	LibraryBig,
	LoaderCircle,
	Plus,
	Puzzle,
	Settings,
	Trash2,
} from "lucide-react";
import { useState, type ReactElement } from "react";

import { Selector } from "./selector.tsx";
import type { ModelInfo, PluginInfo, SessionSummary, SkillInfo } from "../protocol.ts";

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前,更早退回日期。 */
function relativeTime(updatedAt: string): string {
	const then = new Date(updatedAt).getTime();
	if (Number.isNaN(then)) return "";
	const minutes = Math.floor((Date.now() - then) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "昨天";
	if (days < 7) return `${days} 天前`;
	return new Date(updatedAt).toLocaleDateString();
}

function workspaceName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? cwd;
}

/**
 * 左侧任务栏(约 280px):品牌 + 版本、功能菜单(新建任务/技能库/插件市场)、
 * 「任务」「空间」两个分组(空间支持折叠会话、批量删除、单条删除/归档、已归档恢复)、
 * 底部铃铛与设置。全白底,选中态靠浅灰胶囊分层。
 */
export function Sidebar({
	version,
	sessions,
	archived,
	currentId,
	running,
	cwd,
	skills,
	plugins,
	model,
	approvalMode,
	onSwitch,
	onNew,
	onDeleteSessions,
	onArchiveSessions,
	onRestoreSessions,
}: {
	version: string;
	sessions: readonly SessionSummary[];
	archived: readonly SessionSummary[];
	currentId: string;
	running: boolean;
	cwd: string;
	skills: readonly SkillInfo[];
	plugins: readonly PluginInfo[];
	model: ModelInfo;
	approvalMode: string;
	onSwitch: (id: string) => void;
	onNew: () => void;
	onDeleteSessions: (ids: readonly string[]) => void;
	onArchiveSessions: (ids: readonly string[]) => void;
	onRestoreSessions: (id: string) => void;
}): ReactElement {
	const modeLabel = approvalMode === "yolo" ? "完全访问" : approvalMode === "auto" ? "自动审批" : "每次询问";
	const [spaceOpen, setSpaceOpen] = useState(true);
	const [archivedOpen, setArchivedOpen] = useState(false);
	const [manageMode, setManageMode] = useState(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined);

	const toggleSelect = (id: string): void => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const leaveManage = (): void => {
		setManageMode(false);
		setSelected(new Set());
	};

	const batchDelete = (): void => {
		if (selected.size === 0) return;
		onDeleteSessions([...selected]);
		leaveManage();
	};

	const batchArchive = (): void => {
		if (selected.size === 0) return;
		onArchiveSessions([...selected]);
		leaveManage();
	};

	return (
		<aside className="sidebar">
			<div className="side-brand">
				<div className="side-brand-main">
					<span className="logo">R</span>
					<span className="name">Reins</span>
				</div>
				<span className="version">{version}</span>
			</div>
			<nav className="side-menu">
				<button type="button" className="menu-item" onClick={onNew}>
					<Plus size={16} /> 新建任务
				</button>
				<Selector
					panelClass="library-panel"
					display={
						<span className="menu-item">
							<LibraryBig size={16} /> 技能库
						</span>
					}
				>
					{(close) => (
						<>
							<div className="panel-title">技能库</div>
							{skills.length === 0 ? <div className="panel-empty">没有发现技能</div> : null}
							{skills.map((skill) => (
								<button type="button" key={skill.path} className="opt stacked" title={skill.path} onClick={close}>
									<span className="opt-name">{skill.name}</span>
									{skill.description.length > 0 && <span className="opt-desc">{skill.description}</span>}
								</button>
							))}
						</>
					)}
				</Selector>
				<Selector
					panelClass="library-panel"
					display={
						<span className="menu-item">
							<Puzzle size={16} /> 插件市场
						</span>
					}
				>
					{(close) => (
						<>
							<div className="panel-title">已装载的插件</div>
							{plugins.length === 0 ? <div className="panel-empty">尚未装载插件</div> : null}
							{plugins.map((plugin) => (
								<button type="button" key={plugin.name} className="opt stacked" onClick={close}>
									<span className="opt-name">{plugin.name}</span>
									<span className="opt-desc">类型:{plugin.kind}</span>
								</button>
							))}
						</>
					)}
				</Selector>
			</nav>
			<div className="side-scroll">
				<div className="side-section">
					<span>任务 (0)</span>
				</div>
				<div className="side-empty">暂无任务</div>
				<div className="side-section">
					<span>空间 (1)</span>
					<button
						type="button"
						className={"manage" + (manageMode ? " on" : "")}
						title="批量管理会话"
						onClick={() => (manageMode ? leaveManage() : setManageMode(true))}
					>
						管理
					</button>
				</div>
				<button type="button" className="space-row" onClick={() => setSpaceOpen(!spaceOpen)}>
					{spaceOpen ? <ChevronDown size={14} className="chev" /> : <ChevronRight size={14} className="chev" />}
					<Folder size={14} />
					<span className="space-name">{workspaceName(cwd)}</span>
				</button>
				{spaceOpen ? (
					<div className="side-sessions">
						{sessions.length === 0 ? <div className="side-empty">还没有会话</div> : null}
						{sessions.map((session) => {
							const current = session.id === currentId;
							const confirming = confirmingId === session.id;
							return (
								<div key={session.id} className={"session" + (current ? " current" : "")}>
									{manageMode && !current ? (
										<button
											type="button"
											className={"checkbox" + (selected.has(session.id) ? " on" : "")}
											title="选择会话"
											onClick={() => toggleSelect(session.id)}
										>
											{selected.has(session.id) ? <Check size={11} /> : null}
										</button>
									) : null}
									{confirming ? (
										<span className="confirm">
											确认删除?
											<button
												type="button"
												className="confirm-btn danger"
												onClick={() => {
													onDeleteSessions([session.id]);
													setConfirmingId(undefined);
												}}
											>
												删除
											</button>
											<button type="button" className="confirm-btn" onClick={() => setConfirmingId(undefined)}>
												取消
											</button>
										</span>
									) : (
										<>
											<button
												type="button"
												className="session-title"
												onClick={() => {
													if (!current) onSwitch(session.id);
												}}
											>
												{session.title ?? "未命名会话"}
											</button>
											{current && running ? (
												<LoaderCircle size={13} className="spin ok-spin" />
											) : (
												<span className="session-time">{relativeTime(session.updatedAt)}</span>
											)}
											{!manageMode && !current ? (
												<span className="row-actions">
													<button
														type="button"
														title="归档会话"
														onClick={() => onArchiveSessions([session.id])}
													>
														<Archive size={13} />
													</button>
													<button
														type="button"
														title="删除会话"
														onClick={() => setConfirmingId(session.id)}
													>
														<Trash2 size={13} />
													</button>
												</span>
											) : null}
										</>
									)}
								</div>
							);
						})}
					</div>
				) : null}
				{manageMode && selected.size > 0 ? (
					<div className="side-actions">
						<button type="button" className="batch danger" onClick={batchDelete}>
							<Trash2 size={13} /> 删除 ({selected.size})
						</button>
						<button type="button" className="batch" onClick={batchArchive}>
							<Archive size={13} /> 归档 ({selected.size})
						</button>
					</div>
				) : null}
				<div className="side-section">
					<button type="button" className="archived-toggle" onClick={() => setArchivedOpen(!archivedOpen)}>
						{archivedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
						<span>已归档 ({archived.length})</span>
					</button>
				</div>
				{archivedOpen ? (
					<div className="side-sessions archived">
						{archived.length === 0 ? <div className="side-empty">没有归档会话</div> : null}
						{archived.map((session) => (
							<div key={session.id} className="session archived">
								<span className="session-title">{session.title ?? "未命名会话"}</span>
								<span className="row-actions">
									<button type="button" title="恢复到会话列表" onClick={() => onRestoreSessions(session.id)}>
										<ArchiveRestore size={13} />
									</button>
									<button type="button" title="彻底删除" onClick={() => onDeleteSessions([session.id])}>
										<Trash2 size={13} />
									</button>
								</span>
							</div>
						))}
					</div>
				) : null}
			</div>
			<div className="side-foot">
				<Selector panelClass="foot-panel" display={<Bell size={16} />}>
					{() => <div className="panel-empty">暂无通知</div>}
				</Selector>
				<Selector panelClass="foot-panel" display={<Settings size={16} />}>
					{() => (
						<>
							<div className="opt stacked static">
								<span className="opt-name">版本</span>
								<span className="opt-desc">{version}</span>
							</div>
							<div className="opt stacked static">
								<span className="opt-name">工作区</span>
								<span className="opt-desc">{workspaceName(cwd)}</span>
							</div>
							<div className="opt stacked static">
								<span className="opt-name">审批方式</span>
								<span className="opt-desc">{modeLabel}</span>
							</div>
							<div className="opt stacked static">
								<span className="opt-name">模型</span>
								<span className="opt-desc">{model.name}</span>
							</div>
						</>
					)}
				</Selector>
			</div>
		</aside>
	);
}
