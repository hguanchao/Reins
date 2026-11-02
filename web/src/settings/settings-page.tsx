import {
	ArrowLeft,
	Blocks,
	Check,
	Cpu,
	Info,
	Plug,
	Settings2,
	ShieldCheck,
	Sparkles,
	SquareTerminal,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import { Button, cn } from "../components/ui/index.ts";
import type {
	ApprovalMode,
	SettingsSnapshot,
	ThinkingLevel,
} from "../protocol.ts";
import type { ThemeMode } from "../state/theme.ts";
import { UI_FONT_SIZES, applyUiFontSize, readUiFontSize } from "../state/ui-font.ts";

type Section = "general" | "model" | "approval" | "sandbox" | "mcp" | "plugins" | "skills" | "about";

const SECTIONS: readonly { readonly id: Section; readonly label: string; readonly icon: typeof Settings2 }[] = [
	{ id: "general", label: "通用", icon: Settings2 },
	{ id: "model", label: "模型", icon: Cpu },
	{ id: "approval", label: "审批", icon: ShieldCheck },
	{ id: "sandbox", label: "沙箱", icon: SquareTerminal },
	{ id: "mcp", label: "MCP", icon: Plug },
	{ id: "plugins", label: "插件", icon: Blocks },
	{ id: "skills", label: "技能", icon: Sparkles },
	{ id: "about", label: "关于", icon: Info },
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

export interface SettingsPageProps {
	readonly settings: SettingsSnapshot | undefined;
	readonly themeMode: ThemeMode;
	onThemeMode(mode: ThemeMode): void;
	onClose(): void;
	onUpdate(update: { effort?: ThinkingLevel; approval?: ApprovalMode }): void;
	onModel(provider: string, model: string): void;
}

/** 设置页：左侧导航、右侧内容；只有能热更新的项可改。 */
export function SettingsPage(props: SettingsPageProps): ReactElement {
	const [section, setSection] = useState<Section>("general");
	const [fontSize, setFontSize] = useState(readUiFontSize);
	const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]!;

	return (
		<div className="flex h-full min-h-0 bg-background">
			<nav className="flex w-[268px] shrink-0 flex-col border-r border-border/50">
				<div className="px-2 pb-3 pt-2">
					<Button variant="ghost" size="lg" className="w-full justify-start gap-2" onClick={props.onClose}>
						<ArrowLeft className="size-4" />
						返回会话
					</Button>
				</div>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-3">
					{SECTIONS.map((item) => {
						const Icon = item.icon;
						return (
							<button
								key={item.id}
								type="button"
								onClick={() => setSection(item.id)}
								className={cn(
									"flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left text-ui-base transition-colors",
									item.id === section
										? "bg-surface-hover text-foreground"
										: "text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground",
								)}
							>
								<Icon className="size-4" />
								{item.label}
							</button>
						);
					})}
				</div>
			</nav>

			<div className="flex min-w-0 flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-4xl px-8 py-6">
						<h1 className="text-ui-settings-title font-semibold tracking-tight text-foreground">
							{current.label}
						</h1>
						<div className="mt-6 flex flex-col gap-6">
							{section === "general" ? (
								<>
									<Row title="主题" description="界面配色；跟随系统会随操作系统的浅色/深色切换。">
										<ChoiceGroup
											options={(Object.keys(THEME_LABELS) as ThemeMode[]).map((mode) => ({
												key: mode,
												label: THEME_LABELS[mode],
											}))}
											selected={props.themeMode}
											onSelect={(mode) => props.onThemeMode(mode)}
										/>
									</Row>
									<Row title="界面字号" description="只影响界面文字，代码与终端字号不变。">
										<ChoiceGroup
											options={UI_FONT_SIZES.map((size) => ({ key: String(size), label: `${size}px` }))}
											selected={String(fontSize)}
											onSelect={(value) => {
												const size = Number(value);
												setFontSize(size);
												applyUiFontSize(size);
											}}
										/>
									</Row>
								</>
							) : null}

							{section === "model" ? <ModelSection {...props} /> : null}

							{section === "approval" ? (
								<Row title="审批方式" description="改动文件或执行命令前的确认策略。">
									<ChoiceGroup
										options={(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => ({
											key: mode,
											label: APPROVAL_LABELS[mode],
										}))}
										selected={props.settings?.approval ?? "ask"}
										onSelect={(approval) => props.onUpdate({ approval })}
									/>
								</Row>
							) : null}

							{section === "sandbox" ? (
								<Row title="沙箱模式" description="改动需要重启 Reins 才会生效。">
									<span className="rounded-lg bg-surface px-3 py-1.5 font-mono text-ui-sm text-foreground-subtle">
										{props.settings?.sandbox ?? "off"}
									</span>
								</Row>
							) : null}

							{section === "mcp" ? (
								<ListSection
									empty="没有配置 MCP server。"
									items={(props.settings?.mcpServers ?? []).map((server) => ({
										key: server.name,
										title: server.name,
										meta: `${server.type}${server.disabled ? " · 已禁用" : ""}`,
									}))}
								/>
							) : null}

							{section === "plugins" ? (
								<ListSection
									empty="没有装载插件。"
									items={(props.settings?.plugins ?? []).map((plugin) => ({
										key: plugin.name,
										title: plugin.name,
										meta: plugin.kind,
									}))}
								/>
							) : null}

							{section === "skills" ? (
								<ListSection
									empty="没有发现技能。"
									items={(props.settings?.skills ?? []).map((skill) => ({
										key: skill.path,
										title: `$${skill.name}`,
										meta: skill.description,
										detail: skill.path,
									}))}
								/>
							) : null}

							{section === "about" ? (
								<>
									<Row title="版本" description="当前运行的 Reins 版本。">
										<span className="font-mono text-ui-sm text-foreground-subtle">
											{props.settings?.version ?? "—"}
										</span>
									</Row>
									<Row title="配置文件" description="用户级 config.toml 的位置。">
										<span className="break-all font-mono text-ui-sm text-foreground-subtle">
											{props.settings?.configPath ?? "—"}
										</span>
									</Row>
									<Row title="模型配置" description="providers.json 的位置。">
										<span className="break-all font-mono text-ui-sm text-foreground-subtle">
											{props.settings?.providersPath ?? "—"}
										</span>
									</Row>
								</>
							) : null}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function ModelSection(props: SettingsPageProps): ReactElement {
	const settings = props.settings;
	if (settings === undefined) return <div className="text-ui-sm text-foreground-subtle">正在读取配置…</div>;

	const currentModel = settings.models.find(
		(model) => model.provider === settings.provider && model.model === settings.model,
	);
	const levels = currentModel?.thinkingLevels ?? (["off"] as const);

	return (
		<>
			<Row title="当前模型" description="切换后会写回 config.toml，下一轮请求生效。">
				<span className="font-mono text-ui-sm text-foreground-subtle">
					{settings.provider} / {settings.model}
				</span>
			</Row>
			<div className="flex flex-col gap-2">
				<div className="text-ui-base font-semibold text-foreground">可用模型</div>
				{settings.models.map((model) => {
					const active = model.provider === settings.provider && model.model === settings.model;
					return (
						<button
							key={`${model.provider}/${model.model}`}
							type="button"
							onClick={() => props.onModel(model.provider, model.model)}
							className={cn(
								"flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
								active
									? "border-border bg-card-selected"
									: "border-border bg-card hover:bg-surface-hover",
							)}
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
									{model.name}
									<span className="font-mono text-ui-xs text-foreground-subtlest">{model.model}</span>
								</div>
								<div className="mt-0.5 text-ui-sm text-foreground-subtle">
									{model.providerName}
									{model.contextWindow === undefined ? "" : ` · ${model.contextWindow} 上下文`}
									{model.reasoning ? " · 支持思考" : ""}
								</div>
							</div>
							{active ? <Check className="size-4 shrink-0 text-foreground" /> : null}
						</button>
					);
				})}
			</div>
			<Row title="思考等级" description="当前模型支持的等级；关闭表示不发送思考参数。">
				<ChoiceGroup
					options={levels.map((level) => ({ key: level, label: EFFORT_LABELS[level] }))}
					selected={settings.effort}
					onSelect={(effort) => props.onUpdate({ effort })}
				/>
			</Row>
		</>
	);
}

function Row({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="text-ui-base font-medium text-foreground">{title}</div>
				<div className="mt-0.5 text-ui-sm text-foreground-subtle">{description}</div>
			</div>
			{children}
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
		<div className="flex flex-wrap gap-1">
			{options.map((option) => (
				<button
					key={option.key}
					type="button"
					onClick={() => onSelect(option.key)}
					className={cn(
						"flex h-7 items-center gap-1.5 rounded-lg px-3 text-ui-base transition-colors",
						option.key === selected
							? "bg-selected text-foreground"
							: "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
					)}
				>
					{option.key === selected ? <Check className="size-3.5" /> : null}
					{option.label}
				</button>
			))}
		</div>
	);
}

function ListSection({
	empty,
	items,
}: {
	readonly empty: string;
	readonly items: readonly {
		readonly key: string;
		readonly title: string;
		readonly meta: string;
		readonly detail?: string;
	}[];
}): ReactElement {
	if (items.length === 0) {
		return <div className="text-ui-sm text-foreground-subtle">{empty}</div>;
	}
	return (
		<div className="flex flex-col gap-2">
			{items.map((item) => (
				<div key={item.key} className="rounded-xl border border-border bg-card px-4 py-3">
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
							{item.title}
						</span>
						<span className="shrink-0 text-ui-sm text-foreground-subtle">{item.meta}</span>
					</div>
					{item.detail === undefined ? null : (
						<div className="mt-1 break-all font-mono text-ui-xs text-foreground-subtlest">
							{item.detail}
						</div>
					)}
				</div>
			))}
		</div>
	);
}
