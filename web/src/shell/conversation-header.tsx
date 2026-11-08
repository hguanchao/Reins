import { Archive, Ellipsis, ExternalLink, PanelRight, PanelRightClose } from "lucide-react";
import type { ReactElement } from "react";

import { Menu, type MenuEntry } from "../components/ui/index.ts";

/**
 * 会话头。
 *
 * 44px：标题在左，右侧是速率与费用读数（等宽 10px）与两枚图标钮。
 * 结构读数（轮数·步数、上下文）不在这里——它们在输入卡下方的状态条上。
 */
export function ConversationHeader({
	title,
	workspace,
	meta,
	rightbarOpen,
	onToggleRightbar,
	onArchive,
	onReveal,
}: {
	readonly title: string;
	readonly workspace: string;
	/** 会话头只放速率与费用；轮数与 token 在状态条 */
	readonly meta: readonly string[];
	readonly rightbarOpen: boolean;
	onToggleRightbar(): void;
	onArchive(): void;
	onReveal(): void;
}): ReactElement {
	const entries: MenuEntry[] = [
		{ type: "item", key: "reveal", label: "在资源管理器中显示", icon: ExternalLink, onSelect: onReveal },
		{ type: "item", key: "archive", label: "归档此任务", icon: Archive, onSelect: onArchive },
	];

	return (
		<header className="chat-head">
			<div className="title">
				<h2>{title}</h2>
				{workspace.length === 0 ? null : <span className="ws">{workspace}</span>}
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
				title={rightbarOpen ? "关闭面板" : "打开面板"}
				aria-label={rightbarOpen ? "关闭面板" : "打开面板"}
				onClick={onToggleRightbar}
			>
				{rightbarOpen ? <PanelRightClose className="ic-14" /> : <PanelRight className="ic-14" />}
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
						<Ellipsis className="ic-14" />
					</button>
				)}
			/>
		</header>
	);
}
