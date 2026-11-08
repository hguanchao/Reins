import { useEffect, useMemo, useState, type ReactElement } from "react";

import type {
	ActivitySummary,
	ApprovalMode,
	NotifyMode,
	SessionSummary,
	SettingsSnapshot,
	ThinkingLevel,
	UsageSummary,
} from "../protocol.ts";
import type { ThemeMode } from "../state/theme.ts";
import { WindowControls } from "../shell/caption-bar.tsx";
import { AboutSection } from "./about-section.tsx";
import { AppearanceSection } from "./appearance-section.tsx";
import { ArchivedSection } from "./archived-section.tsx";
import { ExtensionsSection } from "./extensions-section.tsx";
import { GeneralSection } from "./general-section.tsx";
import { ModelsSection } from "./models-section.tsx";
import { PersonalizationSection } from "./personalization-section.tsx";
import { filterSettingsNav } from "./settings-model.ts";
import { UsageSection } from "./usage-section.tsx";

export type SettingsSection =
	| "general"
	| "appearance"
	| "models"
	| "personalization"
	| "extensions"
	| "usage"
	| "archived"
	| "about";

interface NavItem {
	readonly id: SettingsSection;
	readonly label: string;
	readonly icon: string;
}

/** 五组平级分区，用留白分组，不加分隔线。 */
const NAV: readonly { readonly label: string; readonly items: readonly NavItem[] }[] = [
	{
		label: "基础设置",
		items: [
			{ id: "general", label: "常规", icon: "settings-2" },
			{ id: "appearance", label: "外观", icon: "palette" },
			{ id: "models", label: "模型", icon: "cpu" },
		],
	},
	{
		label: "Agent 能力",
		items: [
			{ id: "personalization", label: "个性化", icon: "user-round" },
			{ id: "extensions", label: "扩展管理", icon: "blocks" },
		],
	},
	{
		label: "数据",
		items: [
			{ id: "usage", label: "使用统计", icon: "activity" },
			{ id: "archived", label: "已归档任务", icon: "archive" },
		],
	},
	{
		label: "关于",
		items: [{ id: "about", label: "关于 Reins", icon: "info" }],
	},
];

export interface SettingsPageProps {
	readonly settings: SettingsSnapshot | undefined;
	readonly archived: readonly SessionSummary[];
	readonly usage: UsageSummary;
	readonly activity: ActivitySummary;
	readonly themeMode: ThemeMode;
	readonly initialSection?: SettingsSection;
	onThemeMode(mode: ThemeMode): void;
	onClose(): void;
	onUpdate(update: { effort?: ThinkingLevel; approval?: ApprovalMode; notify?: NotifyMode }): void;
	onModel(provider: string, model: string): void;
	onRestore(id: string): void;
	onDeleteArchived(id: string): void;
	onRefresh(): void;
}

/**
 * 设置页。
 *
 * 占满窗口：左侧常驻导航（五组，小号宽字距组标题），右侧 660px 内容列——切页时标题列不横移。
 * 除「个性化」「模型」这类编辑文本的分区外没有页脚保存，设置项即时生效。
 */
export function SettingsPage(props: SettingsPageProps): ReactElement {
	const [section, setSection] = useState<SettingsSection>(props.initialSection ?? "general");
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
		<div className="app set-page" role="region" aria-label="设置">
			<div className="caption drag-region">
				<button
					type="button"
					className="cbtn no-drag"
					aria-label="返回工作区"
					title="返回工作区 (Esc)"
					onClick={onClose}
				>
					<svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="m12 19-7-7 7-7" />
						<path d="M19 12H5" />
					</svg>
				</button>
				<div className="crumb">
					<span>设置</span>
					<span className="sep">/</span>
					<span className="now">
						{NAV.flatMap((group) => group.items).find((item) => item.id === section)?.label}
					</span>
				</div>
				<WindowControls />
			</div>

			<aside className="side" style={{ borderRight: "1px solid var(--rule-2)" }}>
				<div style={{ padding: "10px 10px 0" }}>
					<button type="button" className="nav-row" onClick={onClose} style={{ height: 30, gap: 7 }}>
						<svg className="ic ic-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<path d="m12 19-7-7 7-7" />
							<path d="M19 12H5" />
						</svg>
						<span>返回工作区</span>
					</button>
					<div className="side-search" style={{ marginTop: 8 }}>
						<svg className="ic ic-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
							<path d="m21 21-4.34-4.34" />
							<circle cx="11" cy="11" r="8" />
						</svg>
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索设置"
							aria-label="搜索设置"
						/>
					</div>
				</div>

				<div className="side-scroll" style={{ paddingTop: 6 }}>
					{groups.length === 0 ? (
						<div className="side-sub" style={{ letterSpacing: 0, color: "var(--ink-4)" }}>
							没有匹配的设置项
						</div>
					) : (
						groups.map((group) => (
							<div key={group.label} className="side-sec" style={{ marginTop: 10 }}>
								<div className="side-sub" style={{ paddingLeft: 4 }}>
									{group.label}
								</div>
								{group.items.map((item) => (
									<button
										key={item.id}
										type="button"
										aria-current={item.id === section ? "page" : undefined}
										onClick={() => setSection(item.id)}
										className={`nav-row${item.id === section ? " is-on" : ""}`}
									>
										<NavIcon name={item.icon} />
										<span>{item.label}</span>
									</button>
								))}
							</div>
						))
					)}
				</div>
			</aside>

			<div className="main scroll">
				<div className="set-main">
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
			</div>
		</div>
	);
}

/** 导航图标：直接内联路径，避免为八个小图标各引一次组件。 */
function NavIcon({ name }: { readonly name: string }): ReactElement {
	const paths: Readonly<Record<string, ReactElement>> = {
		"settings-2": (
			<>
				<path d="M14 17H5" />
				<path d="M19 7h-9" />
				<circle cx="17" cy="17" r="3" />
				<circle cx="7" cy="7" r="3" />
			</>
		),
		palette: (
			<>
				<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
				<circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
				<circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
				<circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
				<circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
			</>
		),
		cpu: (
			<>
				<path d="M12 20v2" />
				<path d="M12 2v2" />
				<path d="M17 20v2" />
				<path d="M17 2v2" />
				<path d="M2 12h2" />
				<path d="M2 17h2" />
				<path d="M2 7h2" />
				<path d="M20 12h2" />
				<path d="M20 17h2" />
				<path d="M20 7h2" />
				<path d="M7 20v2" />
				<path d="M7 2v2" />
				<rect x="4" y="4" width="16" height="16" rx="2" />
				<rect x="8" y="8" width="8" height="8" rx="1" />
			</>
		),
		"user-round": (
			<>
				<circle cx="12" cy="8" r="5" />
				<path d="M20 21a8 8 0 0 0-16 0" />
			</>
		),
		blocks: (
			<>
				<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
				<rect x="14" y="2" width="8" height="8" rx="1" />
			</>
		),
		activity: (
			<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
		),
		archive: (
			<>
				<rect width="20" height="5" x="2" y="3" rx="1" />
				<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
				<path d="M10 12h4" />
			</>
		),
		info: (
			<>
				<circle cx="12" cy="12" r="10" />
				<path d="M12 16v-4" />
				<path d="M12 8h.01" />
			</>
		),
	};

	return (
		<svg
			className="ic ic-14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{paths[name]}
		</svg>
	);
}
