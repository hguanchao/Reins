import { Archive, Ellipsis, ExternalLink, FolderOpen } from "lucide-react";
import type { ReactElement } from "react";

import { Menu, type MenuEntry } from "../components/ui/index.ts";

/**
 * 会话头。
 *
 * 44px：标题在左，右侧是速率与费用读数（等宽 10px）与两枚图标钮——
 * 「在新窗口打开」与「更多」，与设计稿一致；面板开关只住在页签条上。
 */
export function ConversationHeader({
	title,
	meta,
	onArchive,
	onReveal,
}: {
	readonly title: string;
	/** 会话头只放速率与费用；轮数与 token 在状态条 */
	readonly meta: readonly string[];
	onArchive(): void;
	onReveal(): void;
}): ReactElement {
	const entries: MenuEntry[] = [
		{ type: "item", key: "reveal", label: "在资源管理器中显示", icon: FolderOpen, onSelect: onReveal },
		{ type: "item", key: "archive", label: "归档此任务", icon: Archive, onSelect: onArchive },
	];

	return (
		<header className="chat-head">
			<div className="title">
				<h2>{title}</h2>
			</div>
			{meta.length === 0 ? null : (
				<div className="meta">
					{meta.map((item, index) => (
						<span key={item} className="flex items-center gap-1.5">
							{index === 0 ? null : <i />}
							<span>{item}</span>
						</span>
					))}
				</div>
			)}
			<button
				type="button"
				className="hbtn"
				title="在新窗口打开"
				aria-label="在新窗口打开"
				onClick={() => window.open(window.location.href, "_blank")}
			>
				<ExternalLink className="ic ic-14" />
			</button>
			<Menu
				align="end"
				entries={entries}
				trigger={({ toggle, open }) => (
					<button
						type="button"
						className="hbtn"
						title="更多"
						aria-label="更多"
						aria-haspopup="menu"
						aria-expanded={open}
						onClick={toggle}
					>
						<Ellipsis className="ic ic-14" />
					</button>
				)}
			/>
		</header>
	);
}
