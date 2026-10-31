import { Bell, Folder, LibraryBig, LoaderCircle, Plus, Puzzle, Settings } from "lucide-react";
import type { ReactElement } from "react";

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
 * 「任务」「空间」两个分组、底部铃铛与设置。全白底,选中态靠浅灰胶囊分层。
 */
export function Sidebar({
	version,
	sessions,
	currentId,
	running,
	cwd,
	skills,
	plugins,
	model,
	approvalMode,
	onSwitch,
	onNew,
}: {
	version: string;
	sessions: readonly SessionSummary[];
	currentId: string;
	running: boolean;
	cwd: string;
	skills: readonly SkillInfo[];
	plugins: readonly PluginInfo[];
	model: ModelInfo;
	approvalMode: string;
	onSwitch: (id: string) => void;
	onNew: () => void;
}): ReactElement {
	const modeLabel = approvalMode === "yolo" ? "完全访问" : approvalMode === "auto" ? "自动审批" : "每次询问";
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
				</div>
				<div className="space-row">
					<Folder size={14} />
					<span className="space-name">{workspaceName(cwd)}</span>
				</div>
				<div className="side-sessions">
					{sessions.map((session) => (
						<button
							type="button"
							key={session.id}
							className={"session" + (session.id === currentId ? " current" : "")}
							onClick={() => {
								if (session.id !== currentId) onSwitch(session.id);
							}}
						>
							<span className="session-title">{session.title ?? "未命名会话"}</span>
							{session.id === currentId && running ? (
								<LoaderCircle size={13} className="spin ok-spin" />
							) : (
								<span className="session-time">{relativeTime(session.updatedAt)}</span>
							)}
						</button>
					))}
				</div>
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
