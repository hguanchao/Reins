import type { ReactElement } from "react";

import type { SessionSummary } from "./types.ts";

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

/** 左侧任务栏:标识、新建任务、本工作区的会话清单。 */
export function Sidebar({
	sessions,
	currentId,
	onSwitch,
	onNew,
}: {
	sessions: readonly SessionSummary[];
	currentId: string;
	onSwitch: (id: string) => void;
	onNew: () => void;
}): ReactElement {
	return (
		<aside className="sidebar">
			<div className="side-brand">
				<span className="logo">R</span>
				<span className="name">Reins</span>
			</div>
			<button type="button" className="new-task" onClick={onNew}>
				<span className="plus">＋</span> 新建任务
			</button>
			<div className="side-section">
				<span className="side-title">任务列表</span>
			</div>
			<div className="side-list">
				{sessions.length === 0 ? <div className="side-empty">还没有会话</div> : null}
				{sessions.map((session) => (
					<button
						type="button"
						key={session.id}
						className={"task" + (session.id === currentId ? " current" : "")}
						onClick={() => {
							if (session.id !== currentId) onSwitch(session.id);
						}}
					>
						<span className={"dot" + (session.id === currentId ? " on" : "")} />
						<span className="task-title">{session.title ?? "未命名会话"}</span>
						<span className="task-time">{relativeTime(session.updatedAt)}</span>
					</button>
				))}
			</div>
		</aside>
	);
}
