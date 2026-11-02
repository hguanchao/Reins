import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import type { ReactElement } from "react";

import { IconButton } from "../components/ui/button.tsx";
import { desktopBridge } from "../platform.ts";
import { WindowControls } from "./window-controls.tsx";

export type TopMenuKind = "edit" | "window" | "help" | "about";

const MENUS: readonly { readonly kind: TopMenuKind; readonly label: string; readonly key: string }[] = [
	{ kind: "edit", label: "编辑", key: "E" },
	{ kind: "window", label: "窗口", key: "W" },
	{ kind: "help", label: "帮助", key: "H" },
	{ kind: "about", label: "关于", key: "A" },
];

/** 顶部菜单条：浏览器式前进/后退、搜索、原生菜单与窗口按钮。 */
export function TopBar({
	canGoBack,
	canGoForward,
	onBack,
	onForward,
	onSearch,
	sidebarCollapsed,
	onToggleSidebar,
}: {
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	onBack(): void;
	onForward(): void;
	onSearch(): void;
	readonly sidebarCollapsed?: boolean;
	onToggleSidebar?(): void;
}): ReactElement {
	const bridge = desktopBridge();

	return (
		<header className="drag-region flex h-9 shrink-0 items-center border-b border-border bg-header px-2">
			<div className="no-drag flex items-center gap-0.5">
				{sidebarCollapsed === undefined || onToggleSidebar === undefined ? null : (
					<IconButton
						label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
						size="icon-sm"
						onClick={onToggleSidebar}
					>
						{sidebarCollapsed ? (
							<PanelLeftOpen className="size-4" />
						) : (
							<PanelLeftClose className="size-4" />
						)}
					</IconButton>
				)}
				<IconButton label="后退" size="icon-sm" disabled={!canGoBack} onClick={onBack}>
					<ArrowLeft className="size-4" />
				</IconButton>
				<IconButton label="前进" size="icon-sm" disabled={!canGoForward} onClick={onForward}>
					<ArrowRight className="size-4" />
				</IconButton>
				<IconButton label="搜索 (Ctrl K)" size="icon-sm" onClick={onSearch}>
					<Search className="size-4" />
				</IconButton>
			</div>

			{bridge === undefined ? null : (
				<>
					<span className="mx-2 h-4 w-px bg-border" />
					<div className="no-drag flex items-center gap-0.5">
						{MENUS.map((item) => (
							<button
								key={item.kind}
								type="button"
								onClick={() => bridge.showMenu(item.kind)}
								className="flex h-6 items-center rounded-md px-2 text-ui-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
							>
								{item.label}
								<span className="ml-0.5 text-ui-xs text-foreground-subtlest">({item.key})</span>
							</button>
						))}
					</div>
				</>
			)}

			<div className="ml-auto flex h-full items-stretch">
				<WindowControls />
			</div>
		</header>
	);
}
