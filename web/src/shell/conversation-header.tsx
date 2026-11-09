import { Archive, Ellipsis, FolderOpen } from "lucide-react";
import type { ReactElement } from "react";

import { Menu, type MenuEntry } from "../components/ui/index.ts";

/**
 * 会话头。
 *
 * 44px：标题在左，右侧只留「更多」菜单；面板开关只住在页签条上。
 */
export function ConversationHeader({
	title,
	onArchive,
	onReveal,
}: {
	readonly title: string;
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
