import {
	Blocks,
	Compass,
	FileCode2,
	Files,
	GitBranch,
	Globe,
	Maximize2,
	Minimize2,
	PanelRightClose,
	Plus,
	Sparkles,
	SquareTerminal,
	X,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Menu, type MenuEntry } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import type { SideTab, SideTabKind } from "./types.ts";

export interface SidePaneProps {
	readonly tabs: readonly SideTab[];
	readonly activeId: string | undefined;
	readonly fullscreen: boolean;
	onSelect(id: string | undefined): void;
	onClose(id: string): void;
	onClosePane(): void;
	onToggleFullscreen(): void;
	onAdd(kind: SideTabKind): void;
	readonly children: ReactNode;
}

const ADD_ENTRIES: readonly { readonly kind: SideTabKind; readonly label: string; readonly icon: typeof Files }[] = [
	{ kind: "files", label: "文件", icon: Files },
	{ kind: "git", label: "Git", icon: GitBranch },
	{ kind: "skills", label: "技能", icon: Sparkles },
	{ kind: "plugins", label: "插件", icon: Blocks },
	{ kind: "browser", label: "浏览器", icon: Globe },
	{ kind: "terminal", label: "终端", icon: SquareTerminal },
];

/** 右侧面板：38px 页签条 + 固定指南页 + 可关闭内容页。 */
export function SidePane(props: SidePaneProps): ReactElement {
	const addEntries: MenuEntry[] = ADD_ENTRIES.map((entry) => ({
		type: "item",
		key: entry.kind,
		label: entry.label,
		icon: entry.icon,
		onSelect: () => props.onAdd(entry.kind),
	}));
	const active = props.tabs.find((tab) => tab.id === props.activeId);

	return (
		<aside
			className={cn(
				"flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l-[0.5px] border-border bg-background",
				props.fullscreen && "rounded-tl-[16px]",
			)}
		>
			<div className="flex h-[38px] shrink-0 items-end gap-1 pl-2.5 pr-1.5">
				<button
					type="button"
					onClick={() => props.onSelect(undefined)}
					className={cn(
						"flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-[13px] leading-none whitespace-nowrap transition-colors",
						props.activeId === undefined
							? "bg-tag text-foreground"
							: "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
					)}
				>
					<Compass className="size-3.5 shrink-0" />
					指南
				</button>

				<div className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
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
						<button
							type="button"
							aria-label="新建页签"
							title="新建页签"
							onClick={toggle}
							className="flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
						>
							<Plus className="size-4" />
						</button>
					)}
					entries={addEntries}
					className="w-52"
				/>
				<button
					type="button"
					aria-label={props.fullscreen ? "退出全屏面板" : "全屏面板"}
					title={props.fullscreen ? "退出全屏面板" : "全屏面板"}
					onClick={props.onToggleFullscreen}
					className="flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
				>
					{props.fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
				</button>
				<button
					type="button"
					aria-label="关闭侧面板"
					title="关闭侧面板"
					onClick={props.onClosePane}
					className="flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
				>
					<PanelRightClose className="size-4" />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden">
				{active === undefined ? (
					<GuideBody onAdd={props.onAdd} />
				) : active.kind === "browser" ? (
					<PlaceholderPanel
						icon={<Globe className="size-8" />}
						title="浏览器面板尚未接入"
						description="当前版本没有内嵌浏览器。网页内容仍会以链接形式打开到系统浏览器。"
					/>
				) : active.kind === "terminal" ? (
					<PlaceholderPanel
						icon={<SquareTerminal className="size-8" />}
						title="终端面板尚未接入"
						description="当前版本的内置终端仍在 Reins 侧运行，界面还没有嵌入交互式终端。"
					/>
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
				"group/tab relative flex h-7 min-w-[80px] max-w-[170px] shrink-0 items-center rounded-sm transition-colors",
				active ? "bg-tag text-foreground" : "text-foreground-subtle hover:bg-surface-hover",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-2 text-left text-[13px] leading-none"
			>
				<Icon className="size-3.5 shrink-0" />
				<span className={cn("min-w-0 flex-1 truncate", active && "pr-3")}>{tab.title}</span>
			</button>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
				aria-label={`关闭 ${tab.title}`}
				title="关闭页签"
				className={cn(
					"absolute right-1 flex size-5 items-center justify-center rounded-sm text-foreground-subtlest opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground",
					active && "opacity-100",
					"group-hover/tab:opacity-100",
				)}
			>
				<X className="size-3" />
			</button>
		</div>
	);
}

function GuideBody({ onAdd }: { onAdd(kind: SideTabKind): void }): ReactElement {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-6">
			<Compass className="mb-1 size-8 text-foreground-subtlest" />
			<div className="mb-2 text-[13px] leading-5 text-foreground-subtlest">打开一个面板开始</div>
			<div className="flex w-full max-w-[300px] flex-col gap-2">
				{ADD_ENTRIES.map((entry) => {
					const Icon = entry.icon;
					return (
						<button
							key={entry.kind}
							type="button"
							onClick={() => onAdd(entry.kind)}
							className="flex min-h-[52px] items-center gap-3 rounded-lg border-[0.5px] border-border bg-card px-3 py-2 text-left transition-colors hover:bg-surface-hover"
						>
							<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-foreground-subtle">
								<Icon className="size-4" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block text-[13px] leading-5 font-medium text-foreground">{entry.label}</span>
								<span className="block text-[11px] leading-4 text-foreground-subtlest">
									{guideDescription(entry.kind)}
								</span>
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function PlaceholderPanel({
	icon,
	title,
	description,
}: {
	readonly icon: ReactElement;
	readonly title: string;
	readonly description: string;
}): ReactElement {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
			<span className="text-foreground-subtlest">{icon}</span>
			<div className="text-[14px] leading-[22px] font-medium text-foreground">{title}</div>
			<div className="max-w-[320px] text-[13px] leading-5 text-foreground-subtlest">{description}</div>
		</div>
	);
}

function guideDescription(kind: SideTabKind): string {
	if (kind === "files") return "浏览项目文件";
	if (kind === "git") return "查看变更与 diff";
	if (kind === "skills") return "已发现的技能";
	if (kind === "plugins") return "已装载插件";
	if (kind === "browser") return "尚未接入";
	return "尚未接入";
}

function iconOf(tab: SideTab) {
	if (tab.kind === "code") return FileCode2;
	if (tab.kind === "git") return GitBranch;
	if (tab.kind === "skills") return Sparkles;
	if (tab.kind === "plugins") return Blocks;
	if (tab.kind === "browser") return Globe;
	if (tab.kind === "terminal") return SquareTerminal;
	return Files;
}
