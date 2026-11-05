import {
	Activity,
	Archive,
	ArrowLeft,
	Blocks,
	Cpu,
	Info,
	Palette,
	Search,
	Settings2,
	UserRound,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";
import type {
	ActivitySummary,
	ApprovalMode,
	SessionSummary,
	SettingsSnapshot,
	ThinkingLevel,
	UsageSummary,
} from "../protocol.ts";
import type { ThemeMode } from "../state/theme.ts";
import { AboutSection } from "./about-section.tsx";
import { AppearanceSection } from "./appearance-section.tsx";
import { ArchivedSection } from "./archived-section.tsx";
import { ExtensionsSection } from "./extensions-section.tsx";
import { GeneralSection } from "./general-section.tsx";
import { ModelsSection } from "./models-section.tsx";
import { PersonalizationSection } from "./personalization-section.tsx";
import { filterSettingsNav } from "./settings-model.ts";
import { UsageSection } from "./usage-section.tsx";

type Section =
	| "general"
	| "appearance"
	| "models"
	| "personalization"
	| "extensions"
	| "usage"
	| "archived"
	| "about";

interface NavItem {
	readonly id: Section;
	readonly label: string;
	readonly icon: LucideIcon;
}

const NAV: readonly { readonly label: string; readonly items: readonly NavItem[] }[] = [
	{
		label: "基础设置",
		items: [
			{ id: "general", label: "常规", icon: Settings2 },
			{ id: "appearance", label: "外观", icon: Palette },
			{ id: "models", label: "模型设置", icon: Cpu },
		],
	},
	{
		label: "Agent 能力",
		items: [
			{ id: "personalization", label: "个性化", icon: UserRound },
			{ id: "extensions", label: "扩展管理", icon: Blocks },
		],
	},
	{
		label: "数据",
		items: [
			{ id: "usage", label: "使用统计", icon: Activity },
			{ id: "archived", label: "已归档任务", icon: Archive },
		],
	},
	{
		label: "关于",
		items: [{ id: "about", label: "关于 Reins", icon: Info }],
	},
];

export interface SettingsPageProps {
	readonly settings: SettingsSnapshot | undefined;
	readonly archived: readonly SessionSummary[];
	readonly usage: UsageSummary;
	readonly activity: ActivitySummary;
	readonly themeMode: ThemeMode;
	onThemeMode(mode: ThemeMode): void;
	onClose(): void;
	onUpdate(update: { effort?: ThinkingLevel; approval?: ApprovalMode }): void;
	onModel(provider: string, model: string): void;
	onRestore(id: string): void;
	onDeleteArchived(id: string): void;
	onRefresh(): void;
}

/** 设置页：左侧分组导航 + 右侧内容列，占满窗口而不是浮层。 */
export function SettingsPage(props: SettingsPageProps): ReactElement {
	const [section, setSection] = useState<Section>("general");
	const [query, setQuery] = useState("");
	const groups = useMemo(() => filterSettingsNav(NAV, query), [query]);
	const onClose = props.onClose;

	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			// 页面里的对话框自己处理 Escape，避免一次按键同时关掉两层
			if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
			const target = event.target as HTMLElement | null;
			if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			role="region"
			aria-label="设置"
			className="fixed inset-0 z-[70] flex flex-col bg-sidebar text-foreground outline-none"
		>
			<div className="drag-region h-(--caption-height) shrink-0" />
			<div className="flex min-h-0 flex-1">
				<aside className="flex w-[244px] shrink-0 flex-col border-r-[0.5px] border-border px-3 pb-3">
					<button
						type="button"
						onClick={props.onClose}
						className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] leading-5 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
					>
						<ArrowLeft className="size-4" />
						返回工作区
					</button>

					<label className="mt-3 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-border bg-background px-2">
						<Search className="size-3.5 shrink-0 text-foreground-subtlest" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索设置"
							aria-label="搜索设置"
							className="min-w-0 flex-1 bg-transparent text-[12px] leading-[18px] outline-none placeholder:text-foreground-subtlest"
						/>
					</label>

					<nav className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
						{groups.length === 0 ? (
							<div className="px-2.5 py-4 text-[12px] leading-[18px] text-foreground-subtlest">
								没有匹配的设置项
							</div>
						) : (
							groups.map((group) => (
								<div key={group.label} className="flex flex-col pb-3">
									<div className="px-2.5 pt-3 pb-1 text-[11px] leading-4 font-medium text-foreground-subtlest">
										{group.label}
									</div>
									{group.items.map((item) => {
										const Icon = item.icon;
										const active = item.id === section;
										return (
											<button
												key={item.id}
												type="button"
												aria-current={active ? "page" : undefined}
												onClick={() => setSection(item.id)}
												className={cn(
													"flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] leading-5 transition-colors",
													active
														? "bg-[var(--sidebar-nav-active)] text-foreground"
														: "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
												)}
											>
												<Icon className="size-4 shrink-0" />
												<span className="min-w-0 flex-1 truncate">{item.label}</span>
											</button>
										);
									})}
								</div>
							))
						)}
					</nav>

					<div className="flex shrink-0 items-center justify-between px-2.5 pt-2 text-[11px] leading-4 text-foreground-subtlest">
						<span>本地模式</span>
						<span className="font-mono">v{props.settings?.version ?? "—"}</span>
					</div>
				</aside>

				<main className="min-w-0 flex-1 overflow-y-auto bg-background">
					<div className="mx-auto flex w-full max-w-[860px] flex-col px-[clamp(28px,5vw,64px)] pt-12 pb-20">
						{section === "general" ? (
							<GeneralSection settings={props.settings} onUpdate={props.onUpdate} />
						) : section === "appearance" ? (
							<AppearanceSection themeMode={props.themeMode} onThemeMode={props.onThemeMode} />
						) : section === "models" ? (
							<ModelsSection
								settings={props.settings}
								onModel={props.onModel}
								onUpdate={props.onUpdate}
								onRefresh={props.onRefresh}
							/>
						) : section === "personalization" ? (
							<PersonalizationSection />
						) : section === "extensions" ? (
							<ExtensionsSection settings={props.settings} onRefresh={props.onRefresh} />
						) : section === "usage" ? (
							<UsageSection usage={props.usage} activity={props.activity} />
						) : section === "archived" ? (
							<ArchivedSection
								archived={props.archived}
								onRestore={props.onRestore}
								onDelete={props.onDeleteArchived}
							/>
						) : (
							<AboutSection settings={props.settings} />
						)}
					</div>
				</main>
			</div>
		</div>
	);
}
