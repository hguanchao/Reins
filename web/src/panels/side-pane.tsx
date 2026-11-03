import {
	Blocks,
	FileCode2,
	Files,
	GitBranch,
	PanelRightClose,
	Plus,
	Sparkles,
	X,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { IconButton } from "../components/ui/button.tsx";
import { cn } from "../components/ui/cn.ts";
import { Menu } from "../components/ui/menu.tsx";
import type { SideTab } from "./types.ts";

export interface SidePaneProps {
	readonly tabs: readonly SideTab[];
	readonly activeId: string | undefined;
	onSelect(id: string): void;
	onClose(id: string): void;
	onClosePane(): void;
	onAdd(kind: "files" | "git" | "skills" | "plugins"): void;
	readonly children: ReactNode;
}

/** 右侧面板帧:48px 页签栏 + 内容区;宽度与拖拽把手都由外层布局承担。 */
export function SidePane(props: SidePaneProps): ReactElement {
	return (
		<aside className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-(--workspace-panel-radius) border-[0.5px] border-border bg-background shadow-xs">
			<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2">
				<div className="flex min-w-0 flex-1 items-center gap-1">
					<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
						{props.tabs.map((tab) => (
							<TabButton
								key={tab.id}
								tab={tab}
								active={tab.id === props.activeId}
								onSelect={() => props.onSelect(tab.id)}
								onClose={() => props.onClose(tab.id)}
							/>
						))}
					</div>
					<Menu
						trigger={({ toggle }) => (
							<IconButton label="新建页签" size="icon-sm" onClick={toggle}>
								<Plus className="size-4" />
							</IconButton>
						)}
						align="start"
						entries={[
							{
								type: "item",
								key: "files",
								label: "文件",
								icon: Files,
								onSelect: () => props.onAdd("files"),
							},
							{
								type: "item",
								key: "git",
								label: "Git",
								icon: GitBranch,
								onSelect: () => props.onAdd("git"),
							},
							{
								type: "item",
								key: "skills",
								label: "技能",
								icon: Sparkles,
								onSelect: () => props.onAdd("skills"),
							},
							{
								type: "item",
								key: "plugins",
								label: "插件",
								icon: Blocks,
								onSelect: () => props.onAdd("plugins"),
							},
						]}
					/>
				</div>
				<IconButton label="关闭侧面板" size="icon-sm" onClick={props.onClosePane}>
					<PanelRightClose className="size-4" />
				</IconButton>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden">
				{props.activeId === undefined ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
						<div className="text-ui-base font-medium text-foreground-subtle">还没有打开的面板</div>
						<div className="text-ui-sm text-foreground-subtlest">
							打开文件、Git 变更、技能或插件列表
						</div>
						<div className="flex gap-2">
							<IconButton label="文件" size="icon-lg" onClick={() => props.onAdd("files")}>
								<Files className="size-4" />
							</IconButton>
							<IconButton label="Git" size="icon-lg" onClick={() => props.onAdd("git")}>
								<GitBranch className="size-4" />
							</IconButton>
							<IconButton label="技能" size="icon-lg" onClick={() => props.onAdd("skills")}>
								<Sparkles className="size-4" />
							</IconButton>
							<IconButton label="插件" size="icon-lg" onClick={() => props.onAdd("plugins")}>
								<Blocks className="size-4" />
							</IconButton>
						</div>
					</div>
				) : (
					props.children
				)}
			</div>
		</aside>
	);
}

function TabButton({
	tab,
	active,
	onSelect,
	onClose,
}: {
	readonly tab: SideTab;
	readonly active: boolean;
	onSelect(): void;
	onClose(): void;
}): ReactElement {
	const Icon = iconOf(tab);
	return (
		<div
			className={cn(
				"group/tab flex h-7 max-w-40 shrink-0 items-center rounded-lg pr-1 text-ui-base font-medium transition-colors",
				active ? "bg-selected text-foreground shadow-xs" : "text-foreground-subtle hover:bg-hover",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
			>
				<Icon className="size-4 shrink-0" />
				<span className="truncate">{tab.title}</span>
			</button>
			<button
				type="button"
				onClick={onClose}
				aria-label="关闭页签"
				className="flex size-5 shrink-0 items-center justify-center rounded text-foreground-subtlest opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover/tab:opacity-100"
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

function iconOf(tab: SideTab) {
	if (tab.kind === "code") return FileCode2;
	if (tab.kind === "git") return GitBranch;
	if (tab.kind === "skills") return Sparkles;
	if (tab.kind === "plugins") return Blocks;
	return Files;
}
