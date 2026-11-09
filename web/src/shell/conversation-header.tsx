import { Archive, Ellipsis, FolderOpen, PanelRight } from "lucide-react";
import type { ReactElement } from "react";

import { Menu, type MenuEntry } from "../components/ui/index.ts";

/**
 * 会话头。
 *
 * 44px：标题在左，右侧是「面板开关 + 更多」两枚钮；面板默认收起，这里是在页签条之外的常驻入口。
 */
export function ConversationHeader({
	title,
	paneOpen,
	onTogglePane,
	onArchive,
	onReveal,
}: {
	readonly title: string;
	/** 右侧面板是否展开：只影响按钮的按下态标识，不改变开关行为 */
	readonly paneOpen: boolean;
	onTogglePane(): void;
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
			<button
				type="button"
				className="hbtn"
				title="显示/隐藏侧面板"
				aria-label="显示/隐藏侧面板"
				aria-pressed={paneOpen}
				onClick={onTogglePane}
			>
				<PanelRight className="ic ic-14" />
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
