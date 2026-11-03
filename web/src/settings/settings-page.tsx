import {
	Archive,
	ArchiveRestore,
	Blocks,
	Bot,
	Check,
	Cpu,
	Database,
	FolderCog,
	Globe2,
	Minus,
	Monitor,
	Moon,
	Plus,
	Settings2,
	ShieldCheck,
	Sparkles,
	Sun,
	Terminal,
	UserRound,
	X,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../components/ui/cn.ts";
import { relativeTime } from "../lib/format.ts";
import type { ApprovalMode, SessionSummary, SettingsSnapshot, ThinkingLevel } from "../protocol.ts";
import type { ThemeMode } from "../state/theme.ts";
import { UI_FONT_SIZES, applyUiFontSize, readUiFontSize } from "../state/ui-font.ts";

type Section = "account" | "general" | "models" | "plugins" | "presets" | "archived";

const SECTIONS: readonly { readonly id: Section; readonly label: string; readonly icon: LucideIcon }[] = [
	{ id: "account", label: "账号与余额", icon: UserRound },
	{ id: "general", label: "通用设置", icon: Settings2 },
	{ id: "models", label: "模型", icon: Cpu },
	{ id: "plugins", label: "内置插件", icon: Blocks },
	{ id: "presets", label: "Agent 预设", icon: Bot },
	{ id: "archived", label: "已归档会话", icon: Archive },
];

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
	ask: "逐次询问",
	auto: "自动审查",
	yolo: "直接放行",
};

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

const THEME_LABELS: Record<ThemeMode, string> = {
	system: "跟随系统",
	"zai-light": "浅色",
	"zai-dark": "深色",
};

const THEME_ICONS: Record<ThemeMode, LucideIcon> = {
	system: Monitor,
	"zai-light": Sun,
	"zai-dark": Moon,
};

export interface SettingsPageProps {
	readonly settings: SettingsSnapshot | undefined;
	readonly archived: readonly SessionSummary[];
	readonly themeMode: ThemeMode;
	onThemeMode(mode: ThemeMode): void;
	onClose(): void;
	onUpdate(update: { effort?: ThinkingLevel; approval?: ApprovalMode }): void;
	onModel(provider: string, model: string): void;
	onRestore(id: string): void;
}

/** 设置浮层：188px 导航轨 + 内容区，账号、通用、模型、插件、预设、归档六个分区。 */
export function SettingsPage(props: SettingsPageProps): ReactElement {
	const [section, setSection] = useState<Section>("account");
	const panel = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			props.onClose();
		};
		document.addEventListener("keydown", onKey);
		panel.current?.focus();
		return () => document.removeEventListener("keydown", onKey);
	}, [props]);

	return createPortal(
		<div className="fixed inset-0 z-[1000] flex items-center justify-center pt-(--caption-height)">
			<div
				className="absolute inset-x-0 bottom-0 top-(--caption-height) bg-black/25"
				aria-hidden="true"
				onClick={props.onClose}
			/>
			<div
				ref={panel}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="设置"
				className="relative z-10 grid h-[min(800px,calc(100vh_-_var(--caption-height)_-_48px))] w-[800px] max-w-[calc(100vw_-_48px)] grid-cols-[188px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[28px] bg-panel shadow-panel-prominent outline-none"
			>
				<div className="col-start-1 row-start-1 px-3 pb-2 pl-6 pt-[22px] text-[16px] leading-6 font-medium">
					设置
				</div>

				<nav className="col-start-1 row-start-2 flex min-h-0 flex-col px-3 pt-2.5">
					<div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
						{SECTIONS.map((entry) => {
							const Icon = entry.icon;
							return (
								<button
									key={entry.id}
									type="button"
									aria-current={entry.id === section ? "true" : undefined}
									onClick={() => setSection(entry.id)}
									className={cn(
										"flex h-10 items-center gap-2 rounded-md px-3 text-left text-[14px] leading-[22px] transition-colors",
										entry.id === section
											? "bg-[var(--sidebar-nav-active)]"
											: "hover:bg-surface-hover",
									)}
								>
									<Icon className="size-4 shrink-0" />
									<span className="min-w-0 flex-1 truncate">{entry.label}</span>
								</button>
							);
						})}
					</div>
				</nav>

				<div className="col-start-2 row-start-1 flex h-[54px] items-start justify-end gap-2 px-3.5 pb-2 pl-2.5 pt-5">
					<button
						type="button"
						aria-label="关闭设置"
						title="关闭设置"
						onClick={props.onClose}
						className="flex size-7 items-center justify-center rounded-sm text-foreground transition-colors hover:bg-surface-hover"
					>
						<X className="size-3.5" />
					</button>
				</div>

				<div className="col-start-2 row-start-2 min-h-0 overflow-y-auto pr-6 pb-6">
					{section === "account" ? <AccountSection settings={props.settings} /> : null}
					{section === "general" ? (
						<GeneralSection
							settings={props.settings}
							themeMode={props.themeMode}
							onThemeMode={props.onThemeMode}
							onUpdate={props.onUpdate}
						/>
					) : null}
					{section === "models" ? (
						<ModelsSection settings={props.settings} onModel={props.onModel} onUpdate={props.onUpdate} />
					) : null}
					{section === "plugins" ? <PluginsSection settings={props.settings} /> : null}
					{section === "presets" ? <PresetsSection /> : null}
					{section === "archived" ? (
						<ArchivedSection archived={props.archived} onRestore={props.onRestore} />
					) : null}
				</div>
			</div>
		</div>,
		document.body,
	);
}

function AccountSection({ settings }: { readonly settings: SettingsSnapshot | undefined }): ReactElement {
	return (
		<SectionBody title="账号与余额" intro="当前版本使用本地配置，不需要登录 DeepSeek 账号。">
			<div className="flex flex-col gap-3 rounded-xl border-[0.5px] border-border bg-card p-4">
				<div className="flex items-center gap-3">
					<span className="flex size-10 items-center justify-center rounded-full bg-surface text-foreground-subtle">
						<UserRound className="size-5" />
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="text-[14px] leading-[22px] font-medium">本地模式</span>
							<span className="rounded-xs border-[0.5px] border-border px-1.5 text-[11px] leading-4 text-foreground-subtle">
								未登录
							</span>
						</div>
						<div className="mt-0.5 text-[12px] leading-[18px] text-foreground-subtlest">
							API Key 与模型配置保存在本机
						</div>
					</div>
					<button
						type="button"
						disabled
						className="h-7 rounded-sm border-[0.5px] border-border px-3 text-[12px] leading-[18px] opacity-40"
					>
						登录
					</button>
				</div>
				<div className="grid grid-cols-2 gap-3 border-t-[0.5px] border-border pt-3">
					<BalanceCell label="充值余额" value="—" />
					<BalanceCell label="赠金余额" value="—" />
				</div>
			</div>

			<SettingRow title="账号服务" description="登录、余额、用量与充值接口尚未接入；当前版本不创建账号数据。">
				<span className="flex h-7 items-center rounded-sm bg-surface px-2.5 text-[12px] leading-[18px] text-foreground-subtle">
					暂不可用
				</span>
			</SettingRow>

			<SettingRow title="配置文件" description="用户级 config.toml 的位置。">
				<span className="max-w-[360px] break-all text-right font-mono text-[11px] leading-4 text-foreground-subtle">
					{settings?.configPath ?? "—"}
				</span>
			</SettingRow>
		</SectionBody>
	);
}

function BalanceCell({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-[12px] leading-[18px] text-foreground-subtlest">{label}</span>
			<span className="text-[16px] leading-6 font-medium tabular-nums">{value}</span>
		</div>
	);
}

function GeneralSection({
	settings,
	themeMode,
	onThemeMode,
	onUpdate,
}: {
	readonly settings: SettingsSnapshot | undefined;
	readonly themeMode: ThemeMode;
	onThemeMode(mode: ThemeMode): void;
	onUpdate(update: { effort?: ThinkingLevel; approval?: ApprovalMode }): void;
}): ReactElement {
	const [fontSize, setFontSize] = useState(readUiFontSize);

	return (
		<SectionBody title="通用设置" intro="界面外观、字号与交互行为。">
			<div className="flex flex-col gap-2 py-4">
				<div className="text-[14px] leading-[22px]">外观</div>
				<div className="flex flex-wrap gap-2">
					{(Object.keys(THEME_LABELS) as ThemeMode[]).map((mode) => {
						const Icon = THEME_ICONS[mode];
						return (
							<button
								key={mode}
								type="button"
								onClick={() => onThemeMode(mode)}
								className={cn(
									"flex min-h-[82px] flex-1 basis-[180px] flex-col items-center justify-center gap-1 rounded-xl border-[0.5px] px-8 py-5 text-[14px] leading-[22px] transition-colors",
									mode === themeMode
										? "border-foreground-subtlest bg-surface"
										: "border-border hover:bg-surface-hover",
								)}
							>
								<Icon className="size-5" />
								{THEME_LABELS[mode]}
							</button>
						);
					})}
				</div>
			</div>

			<SettingRow title="语言" description="界面语言。当前只有简体中文。">
				<span className="flex h-7 items-center rounded-sm border-[0.5px] border-border px-2.5 text-[12px] leading-[18px] text-foreground-subtle">
					简体中文
				</span>
			</SettingRow>

			<SettingRow title="界面字号" description="只影响对话内容字号，代码与终端字号保持不变。">
				<div className="flex items-center gap-2">
					<div className="flex h-9 items-center rounded-md bg-surface px-1">
						<button
							type="button"
							aria-label="减小字号"
							onClick={() => {
								const next = Math.max(UI_FONT_SIZES[0] ?? 13, fontSize - 1);
								setFontSize(next);
								applyUiFontSize(next);
							}}
							className="flex size-6 items-center justify-center rounded-xs text-foreground-subtle hover:bg-surface-hover"
						>
							<Minus className="size-3" />
						</button>
						<span className="w-10 text-center text-[14px] leading-[22px] tabular-nums">{fontSize}</span>
						<button
							type="button"
							aria-label="增大字号"
							onClick={() => {
								const next = Math.min(UI_FONT_SIZES[UI_FONT_SIZES.length - 1] ?? 16, fontSize + 1);
								setFontSize(next);
								applyUiFontSize(next);
							}}
							className="flex size-6 items-center justify-center rounded-xs text-foreground-subtle hover:bg-surface-hover"
						>
							<Plus className="size-3" />
						</button>
					</div>
					<span className="text-[14px] leading-[22px] text-foreground-subtle">px</span>
				</div>
			</SettingRow>

			<SettingRow title="字体" description="正文与界面使用系统字体。自定义字体尚未接入。">
				<span className="flex h-7 items-center rounded-sm border-[0.5px] border-border px-2.5 text-[12px] leading-[18px] text-foreground-subtle">
					系统默认
				</span>
			</SettingRow>

			<SettingRow title="繁杂时的发送行为" description="智能体运行时 Enter 与发送按钮的行为。">
				<div className="flex items-center gap-1">
					<span className="flex h-7 items-center rounded-sm bg-surface px-2.5 text-[12px] leading-[18px]">
						排队发送
					</span>
					<span className="flex h-7 items-center rounded-sm px-2.5 text-[12px] leading-[18px] text-foreground-subtlest opacity-50">
						插话发送
					</span>
				</div>
			</SettingRow>

			<SettingRow title="审批方式" description="改动文件或执行命令前的确认策略。">
				<ChoiceGroup
					options={(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => ({
						key: mode,
						label: APPROVAL_LABELS[mode],
					}))}
					selected={settings?.approval ?? "ask"}
					onSelect={(approval) => onUpdate({ approval })}
				/>
			</SettingRow>

			<SettingRow title="版本" description="当前运行的 Reins 版本。">
				<span className="font-mono text-[12px] leading-[18px] text-foreground-subtle">
					{settings?.version ?? "—"}
				</span>
			</SettingRow>
		</SectionBody>
	);
}

function ModelsSection({
	settings,
	onModel,
	onUpdate,
}: {
	readonly settings: SettingsSnapshot | undefined;
	onModel(provider: string, model: string): void;
	onUpdate(update: { effort?: ThinkingLevel; approval?: ApprovalMode }): void;
}): ReactElement {
	if (settings === undefined) {
		return <SectionBody title="模型" intro="正在读取配置…" />;
	}

	const groups = new Map<string, SettingsSnapshot["models"][number][]>();
	for (const model of settings.models) {
		const list = groups.get(model.providerName) ?? [];
		list.push(model);
		groups.set(model.providerName, list);
	}
	const current = settings.models.find(
		(model) => model.provider === settings.provider && model.model === settings.model,
	);
	const levels = current?.thinkingLevels ?? (["off"] as const);

	return (
		<SectionBody title="模型" intro="模型来自本机 providers.json；切换后会写回当前配置。">
			{groups.size === 0 ? (
				<div className="rounded-xl border-[0.5px] border-border bg-card px-4 py-6 text-[13px] leading-5 text-foreground-subtlest">
					没有发现可用模型。请先在 providers.json 中配置提供方。
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{[...groups.entries()].map(([providerName, models]) => (
						<div
							key={providerName}
							className="flex flex-col gap-3 rounded-xl border-[0.5px] border-border bg-card p-3.5"
						>
							<div className="flex items-center gap-2.5">
								<span className="size-2 rounded-full bg-success" />
								<span className="text-[14px] leading-[22px] font-medium">{providerName}</span>
								<span className="rounded-xs border-[0.5px] border-border px-1.5 text-[11px] leading-4 text-foreground-subtle">
									已配置
								</span>
								<span className="ml-auto text-[12px] leading-[18px] text-foreground-subtlest">
									{models.length} 个模型
								</span>
							</div>
							<div className="flex flex-col gap-0.5">
								{models.map((model) => {
									const active = model.provider === settings.provider && model.model === settings.model;
									return (
										<button
											key={`${model.provider}/${model.model}`}
											type="button"
											onClick={() => onModel(model.provider, model.model)}
											className={cn(
												"flex min-h-9 items-center gap-2.5 rounded-md px-2 text-left transition-colors",
												active ? "bg-surface" : "hover:bg-surface-hover",
											)}
										>
											<span
												className={cn(
													"flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]",
													active ? "border-(--business-blue)" : "border-border",
												)}
											>
												{active ? <span className="size-2 rounded-full bg-(--business-blue)" /> : null}
											</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate text-[14px] leading-[22px]">{model.name}</span>
												<span className="block truncate font-mono text-[11px] leading-4 text-foreground-subtlest">
													{model.model}
												</span>
											</span>
											{model.reasoning ? (
												<span className="shrink-0 rounded-xs bg-surface px-1.5 text-[11px] leading-4 text-foreground-subtle">
													思考
												</span>
											) : null}
											<span className="shrink-0 font-mono text-[11px] leading-4 text-foreground-subtlest">
												{model.contextWindow === undefined ? "—" : formatTokens(model.contextWindow)}
											</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			)}

			<SettingRow title="思考等级" description="当前模型支持的等级；关闭表示不发送思考参数。">
				<ChoiceGroup
					options={levels.map((level) => ({ key: level, label: EFFORT_LABELS[level] }))}
					selected={settings.effort}
					onSelect={(effort) => onUpdate({ effort })}
				/>
			</SettingRow>

			<SettingRow title="当前模型" description="本轮会话使用的提供方与模型标识。">
				<span className="font-mono text-[12px] leading-[18px] text-foreground-subtle">
					{settings.provider} / {settings.model}
				</span>
			</SettingRow>

			<div className="flex items-center gap-2 pt-4">
				<button
					type="button"
					disabled
					className="h-9 rounded-md border-[0.5px] border-border px-3.5 text-[14px] leading-[22px] opacity-40"
				>
					添加提供方
				</button>
				<span className="text-[12px] leading-[18px] text-foreground-subtlest">
					提供方与模型编辑尚未接入，当前只支持切换。
				</span>
			</div>
		</SectionBody>
	);
}

const PLUGIN_TABS = ["tools", "sandbox", "mcp", "skills", "subagent"] as const;
type PluginTab = (typeof PLUGIN_TABS)[number];

const PLUGIN_TAB_LABELS: Record<PluginTab, string> = {
	tools: "内置工具",
	sandbox: "沙箱",
	mcp: "MCP",
	skills: "技能",
	subagent: "子智能体",
};

function PluginsSection({ settings }: { readonly settings: SettingsSnapshot | undefined }): ReactElement {
	const [tab, setTab] = useState<PluginTab>("tools");

	return (
		<SectionBody title="内置插件" intro="Reins 的核心能力全部内置；插件用于接入外部工具或替换已有手段。">
			<div className="flex gap-5 border-b-[0.5px] border-border">
				{PLUGIN_TABS.map((id) => (
					<button
						key={id}
						type="button"
						onClick={() => setTab(id)}
						className={cn(
							"relative -mb-px pb-2.5 text-[13px] leading-4 font-medium transition-colors",
							tab === id ? "text-(--business-blue)" : "text-foreground-subtlest hover:text-foreground-subtle",
						)}
					>
						{PLUGIN_TAB_LABELS[id]}
						<span
							className={cn(
								"absolute inset-x-0 bottom-0 h-0.5 rounded-full",
								tab === id ? "bg-(--business-blue)" : "bg-transparent",
							)}
						/>
					</button>
				))}
			</div>

			<div className="flex flex-col gap-2 pt-4">
				{tab === "tools" ? (
					<PluginCards
						cards={[
							{ title: "文件工具", detail: "读取、写入、编辑、搜索与列目录", icon: FolderCog },
							{ title: "命令工具", detail: "bash 与 PowerShell，受沙箱与审批约束", icon: Terminal },
							{ title: "计划与任务", detail: "plan、todo、checkpoint 与回合折叠", icon: ShieldCheck },
							{ title: "网络访问", detail: "web_fetch 与网页内容提取", icon: Globe2 },
						]}
					/>
				) : null}

				{tab === "sandbox" ? (
					<>
						<SettingRow title="沙箱模式" description="命令隔离使用的系统设施；改动需要重启 Reins。">
							<span className="rounded-sm bg-surface px-2.5 py-1 font-mono text-[12px] leading-[18px] text-foreground-subtle">
								{settings?.sandbox ?? "off"}
							</span>
						</SettingRow>
						<SettingRow title="路径边界" description="文件读写与命令工作目录都由宿主校验，插件不能绕过。">
							<span className="text-[12px] leading-[18px] text-foreground-subtle">宿主内置</span>
						</SettingRow>
					</>
				) : null}

				{tab === "mcp" ? (
					(settings?.mcpServers ?? []).length === 0 ? (
						<EmptySetting text="没有配置 MCP server。" />
					) : (
						<div className="flex flex-col gap-2">
							{(settings?.mcpServers ?? []).map((server) => (
								<div
									key={server.name}
									className="flex items-center gap-3 rounded-xl border-[0.5px] border-border bg-card px-4 py-3"
								>
									<Database className="size-4 shrink-0 text-foreground-subtle" />
									<span className="min-w-0 flex-1 truncate text-[14px] leading-[22px]">{server.name}</span>
									<span className="text-[12px] leading-[18px] text-foreground-subtle">{server.type}</span>
									<span className="text-[12px] leading-[18px] text-foreground-subtlest">
										{server.disabled ? "已禁用" : "已启用"}
									</span>
								</div>
							))}
						</div>
					)
				) : null}

				{tab === "skills" ? (
					(settings?.skills ?? []).length === 0 ? (
						<EmptySetting text="没有发现技能。" />
					) : (
						<div className="flex flex-col gap-2">
							{(settings?.skills ?? []).map((skill) => (
								<div
									key={skill.path}
									className="flex flex-col gap-1 rounded-xl border-[0.5px] border-border bg-card px-4 py-3"
								>
									<div className="flex items-center gap-2">
										<Sparkles className="size-4 shrink-0 text-foreground-subtle" />
										<span className="min-w-0 flex-1 truncate text-[14px] leading-[22px]">${skill.name}</span>
									</div>
									<div className="text-[12px] leading-[18px] text-foreground-subtle">{skill.description}</div>
									<div className="break-all font-mono text-[11px] leading-4 text-foreground-subtlest">
										{skill.path}
									</div>
								</div>
							))}
						</div>
					)
				) : null}

				{tab === "subagent" ? (
					<div className="flex flex-col items-start gap-2 rounded-xl border-[0.5px] border-border bg-card px-4 py-5">
						<Bot className="size-5 text-foreground-subtlest" />
						<div className="text-[14px] leading-[22px] font-medium">子智能体尚未接入</div>
						<p className="m-0 max-w-[520px] text-[13px] leading-5 text-foreground-subtlest">
							子智能体需要独立的会话层级、并行调度与结果回收。当前版本仍由单一智能体执行任务，这里不会显示虚构的子智能体。
						</p>
					</div>
				) : null}
			</div>
		</SectionBody>
	);
}

function PresetsSection(): ReactElement {
	const presets = [
		{
			name: "标准模式",
			description: "处理代码、文件和资料，适合大多数任务。按需使用检索、编辑与终端等工具。",
			available: true,
		},
		{
			name: "PTC 模式",
			description: "面向工具调用的强约束模式，把步骤拆成可检查的调用序列。",
			available: false,
		},
		{
			name: "极简模式",
			description: "只保留必要工具与最短提示词，适合简单问答。",
			available: false,
		},
		{
			name: "创作模式",
			description: "让智能体帮助创建新的预设与插件包。",
			available: false,
		},
	];

	return (
		<SectionBody title="Agent 预设" intro="决定新会话使用的提示词、工具集与执行风格。">
			<div className="grid gap-2 sm:grid-cols-2">
				{presets.map((preset) => (
					<button
						key={preset.name}
						type="button"
						disabled={!preset.available}
						className={cn(
							"flex flex-col items-start gap-2 rounded-xl border-[0.5px] p-4 text-left transition-colors",
							preset.available
								? "border-(--business-blue) bg-[var(--business-blue-soft)]"
								: "border-border bg-card opacity-60",
						)}
					>
						<div className="flex w-full items-center gap-2">
							<span
								className={cn(
									"flex size-4 items-center justify-center rounded-full border-[1.5px]",
									preset.available ? "border-(--business-blue)" : "border-border",
								)}
							>
								{preset.available ? <Check className="size-3 text-(--business-blue)" /> : null}
							</span>
							<span className="min-w-0 flex-1 truncate text-[14px] leading-[22px] font-medium">
								{preset.name}
							</span>
							{preset.available ? (
								<span className="text-[11px] leading-4 text-(--business-blue)">当前</span>
							) : (
								<span className="text-[11px] leading-4 text-foreground-subtlest">尚未接入</span>
							)}
						</div>
						<p className="m-0 text-[12px] leading-[18px] text-foreground-subtle">{preset.description}</p>
					</button>
				))}
			</div>

			<div className="flex items-center gap-2 pt-4">
				<button
					type="button"
					disabled
					className="h-9 rounded-md border-[0.5px] border-border px-3.5 text-[14px] leading-[22px] opacity-40"
				>
					创建预设
				</button>
				<span className="text-[12px] leading-[18px] text-foreground-subtlest">
					预设编辑与自定义插件包尚未接入。
				</span>
			</div>
		</SectionBody>
	);
}

function ArchivedSection({
	archived,
	onRestore,
}: {
	readonly archived: readonly SessionSummary[];
	onRestore(id: string): void;
}): ReactElement {
	return (
		<SectionBody title="已归档会话" intro="归档不会删除数据，可以随时恢复。">
			{archived.length === 0 ? (
				<div className="flex flex-col items-center gap-2 py-20 text-[13px] leading-5 text-foreground-subtlest">
					<Archive className="size-6" />
					<span>没有已归档的会话</span>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{archived.map((session) => (
						<div
							key={session.id}
							className="flex items-center gap-3 rounded-xl border-[0.5px] border-border bg-card px-4 py-3"
						>
							<span className="min-w-0 flex-1 truncate text-[14px] leading-[22px]">
								{session.title ?? "未命名会话"}
							</span>
							<span className="shrink-0 text-[11px] leading-4 text-foreground-subtlest">
								{relativeTime(session.updatedAt)}
							</span>
							<button
								type="button"
								onClick={() => onRestore(session.id)}
								className="flex h-7 items-center gap-1 rounded-sm border-[0.5px] border-border px-2.5 text-[12px] leading-[18px] transition-colors hover:bg-surface-hover"
							>
								<ArchiveRestore className="size-3.5" />
								恢复
							</button>
						</div>
					))}
				</div>
			)}
		</SectionBody>
	);
}

function SectionBody({
	title,
	intro,
	children,
}: {
	readonly title: string;
	readonly intro: string;
	readonly children?: ReactNode;
}): ReactElement {
	return (
		<div className="flex max-w-[720px] flex-col gap-3 text-foreground">
			<h2 className="m-0 pt-1 text-[16px] leading-6 font-medium">{title}</h2>
			<p className="m-0 text-[14px] leading-[22px] text-foreground-subtlest">{intro}</p>
			{children}
		</div>
	);
}

function SettingRow({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<div className="flex items-center gap-2 border-b-[0.5px] border-border py-4 last:border-b-0">
			<div className="flex min-w-0 flex-1 flex-col gap-1 pr-12">
				<span className="text-[14px] leading-[22px]">{title}</span>
				<span className="text-[12px] leading-[18px] text-foreground-subtlest">{description}</span>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function ChoiceGroup<T extends string>({
	options,
	selected,
	onSelect,
}: {
	readonly options: readonly { readonly key: T; readonly label: string }[];
	readonly selected: T;
	onSelect(key: T): void;
}): ReactElement {
	return (
		<div className="flex flex-wrap items-center gap-1">
			{options.map((option) => (
				<button
					key={option.key}
					type="button"
					onClick={() => onSelect(option.key)}
					className={cn(
						"flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[12px] leading-[18px] transition-colors",
						option.key === selected
							? "bg-surface text-foreground"
							: "text-foreground-subtle hover:bg-surface-hover",
					)}
				>
					{option.key === selected ? <Check className="size-3" /> : null}
					{option.label}
				</button>
			))}
		</div>
	);
}

function PluginCards({
	cards,
}: {
	readonly cards: readonly { readonly title: string; readonly detail: string; readonly icon: LucideIcon }[];
}): ReactElement {
	return (
		<div className="grid gap-2 sm:grid-cols-2">
			{cards.map((card) => {
				const Icon = card.icon;
				return (
					<div
						key={card.title}
						className="flex items-start gap-3 rounded-xl border-[0.5px] border-border bg-card p-3.5"
					>
						<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-foreground-subtle">
							<Icon className="size-4" />
						</span>
						<div className="min-w-0">
							<div className="text-[14px] leading-[22px] font-medium">{card.title}</div>
							<div className="text-[12px] leading-[18px] text-foreground-subtlest">{card.detail}</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function EmptySetting({ text }: { readonly text: string }): ReactElement {
	return (
		<div className="rounded-xl border-[0.5px] border-border bg-card px-4 py-5 text-[13px] leading-5 text-foreground-subtlest">
			{text}
		</div>
	);
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}
