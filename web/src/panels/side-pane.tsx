import {
	Blocks,
	Compass,
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

/**
 * 右侧面板。
 *
 * 页签条 36px，选中项用 2px 墨色下划线而不是胶囊底；关闭按钮只在悬停时出现。
 * 「指南」是固定页，永远在最左，形态为纯文字加图标。
 */
export function SidePane(props: SidePaneProps): ReactElement {
	const entries: MenuEntry[] = ADD_ENTRIES.map((entry) => ({
		type: "item",
		key: entry.kind,
		label: entry.label,
		icon: entry.icon,
		onSelect: () => props.onAdd(entry.kind),
	}));
	const active = props.tabs.find((tab) => tab.id === props.activeId);

	return (
		<aside className="panel">
			<div className="panel-tabs">
				<button
					type="button"
					className="ptab"
					aria-selected={props.activeId === undefined}
					onClick={() => props.onSelect(undefined)}
				>
					<Compass className="ic ic-12" />
					指南
				</button>

				<div className="flex min-w-0 flex-1 items-center overflow-x-auto">
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

				<div className="pt-actions">
					<Menu
						align="end"
						entries={entries}
						trigger={({ toggle, open }) => (
							<button
								type="button"
								aria-label="新建页签"
								title="新建页签"
								aria-haspopup="menu"
								aria-expanded={open}
								onClick={toggle}
							>
								<Plus className="ic ic-14" />
							</button>
						)}
					/>
					<button
						type="button"
						aria-label={props.fullscreen ? "退出全屏面板" : "全屏面板"}
						title={props.fullscreen ? "退出全屏面板" : "全屏面板"}
						onClick={props.onToggleFullscreen}
					>
						{props.fullscreen ? <Minimize2 className="ic ic-14" /> : <Maximize2 className="ic ic-14" />}
					</button>
					<button type="button" aria-label="关闭侧面板" title="关闭侧面板" onClick={props.onClosePane}>
						<PanelRightClose className="ic ic-14" />
					</button>
				</div>
			</div>

			<div className="panel-body">
				{active === undefined ? (
					<GuideBody onAdd={props.onAdd} />
				) : active.kind === "browser" ? (
					<Placeholder
						title="浏览器面板尚未接入"
						description="当前版本没有内嵌浏览器。网页内容仍会以链接形式打开到系统浏览器。"
					/>
				) : active.kind === "terminal" ? (
					<Placeholder
						title="终端面板尚未接入"
						description="命令执行仍在 Reins 侧运行；这里不提供交互式终端，避免与内核的工作目录状态分叉。"
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
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onSelect}
			className="ptab group/tab shrink-0"
		>
			<Icon className="ic ic-12" />
			<span className="max-w-[120px] truncate">{tab.title}</span>
			<span
				className="x"
				role="button"
				tabIndex={-1}
				aria-label={`关闭 ${tab.title}`}
				title="关闭页签"
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
			>
				<X className="ic ic-12" />
			</span>
		</button>
	);
}

function Placeholder({ title, description }: { readonly title: string; readonly description: string }): ReactElement {
	return (
		<div className="empty" style={{ paddingTop: 60 }}>
			<span className="mk">
				<Compass className="ic ic-14" />
			</span>
			<span className="t">{title}</span>
			<span className="d">{description}</span>
		</div>
	);
}

function GuideBody({ onAdd }: { onAdd(kind: SideTabKind): void }): ReactElement {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 px-5 pb-10">
			<Compass
				className="mb-1"
				style={{ width: "calc(var(--ui-font-size, 14px) * 24 / 14)", height: "calc(var(--ui-font-size, 14px) * 24 / 14)", color: "var(--ink-3)" }}
			/>
			<div className="mb-2 text-[var(--fs-12)]" style={{ color: "var(--ink-3)" }}>
				打开一个面板开始
			</div>
			<div className="flex w-full max-w-[260px] flex-col">
				{ADD_ENTRIES.map((entry) => {
					const Icon = entry.icon;
					return (
						<button
							key={entry.kind}
							type="button"
							onClick={() => onAdd(entry.kind)}
							style={{ borderBottom: "1px solid var(--rule)" }}
							className="flex items-center gap-2.5 py-2.5 text-left text-[var(--fs-12)]"
						>
							<Icon className="ic ic-14" style={{ color: "var(--ink-3)" }} />
							<span className="flex-1" style={{ color: "var(--ink-2)" }}>
								{entry.label}
							</span>
							<span className="text-[var(--fs-9)]" style={{ color: "var(--ink-4)" }}>
								{guideDescription(entry.kind)}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function guideDescription(kind: SideTabKind): string {
	if (kind === "files") return "浏览项目文件";
	if (kind === "git") return "变更与 diff";
	if (kind === "skills") return "已发现的技能";
	if (kind === "plugins") return "已装载插件";
	if (kind === "browser") return "尚未接入";
	return "尚未接入";
}

function iconOf(tab: SideTab) {
	if (tab.kind === "git") return GitBranch;
	if (tab.kind === "skills") return Sparkles;
	if (tab.kind === "plugins") return Blocks;
	if (tab.kind === "browser") return Globe;
	if (tab.kind === "terminal") return SquareTerminal;
	return Files;
}
