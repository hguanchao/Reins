import { Check, Minus, Monitor, Moon, Plus, Sun, type LucideIcon } from "lucide-react";
import { useState, type ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";
import type { ThemeMode } from "../state/theme.ts";
import { UI_FONT_SIZES, applyUiFontSize, readUiFontSize } from "../state/ui-font.ts";
import { Badge, SettingRow, SettingsCard, SettingsHeader } from "./controls.tsx";

const THEMES: readonly {
	readonly mode: ThemeMode;
	readonly label: string;
	readonly description: string;
	readonly icon: LucideIcon;
}[] = [
	{ mode: "system", label: "跟随系统", description: "随系统深浅色自动切换", icon: Monitor },
	{ mode: "zai-light", label: "浅色", description: "纸白底与墨黑文字", icon: Sun },
	{ mode: "zai-dark", label: "深色", description: "近黑底与浅色文字", icon: Moon },
];

/** 外观：主题与界面字号立即生效；字体族当前固定为系统字体。 */
export function AppearanceSection({
	themeMode,
	onThemeMode,
}: {
	readonly themeMode: ThemeMode;
	onThemeMode(mode: ThemeMode): void;
}): ReactElement {
	const [fontSize, setFontSize] = useState(readUiFontSize);
	const changeFontSize = (next: number): void => {
		setFontSize(next);
		applyUiFontSize(next);
	};

	return (
		<div className="flex flex-col gap-7">
			<SettingsHeader title="外观" description="主题、界面字号与字体。" />

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">主题</h2>
				<div className="grid gap-2 sm:grid-cols-3">
					{THEMES.map((theme) => {
						const Icon = theme.icon;
						const active = themeMode === theme.mode;
						return (
							<button
								key={theme.mode}
								type="button"
								onClick={() => onThemeMode(theme.mode)}
								aria-pressed={active}
								className={cn(
									"flex flex-col gap-2.5 rounded-[14px] border-[0.5px] p-3 text-left transition-colors",
									active
										? "border-foreground bg-surface"
										: "border-border bg-card hover:bg-surface-hover",
								)}
							>
								<span
									data-theme={theme.mode === "system" ? undefined : theme.mode}
									className="flex h-12 w-full items-center gap-1 rounded-lg border-[0.5px] border-border bg-background px-3"
								>
									<span className="h-1.5 w-7 rounded-full bg-foreground/75" />
									<span className="h-1.5 w-4 rounded-full bg-foreground-subtlest" />
								</span>
								<span className="flex items-center gap-2">
									<Icon className="size-3.5 shrink-0 text-foreground-subtle" />
									<span className="min-w-0 flex-1 text-[13px] leading-5 font-medium">
										{theme.label}
									</span>
									{active ? <Check className="size-3.5 shrink-0" /> : null}
								</span>
								<span className="text-[11px] leading-4 text-foreground-subtlest">
									{theme.description}
								</span>
							</button>
						);
					})}
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">字体</h2>
				<SettingsCard>
					<SettingRow
						title="界面字号"
						description="只影响对话与界面文字，代码和终端字号保持不变。"
					>
						<div className="flex h-8 items-center gap-2 rounded-lg bg-surface px-1">
							<button
								type="button"
								aria-label="减小字号"
								onClick={() => {
									const next = Math.max(UI_FONT_SIZES[0] ?? 13, fontSize - 1);
									changeFontSize(next);
								}}
								className="flex size-6 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
							>
								<Minus className="size-3" />
							</button>
							<span className="w-9 text-center text-[12px] leading-[18px] tabular-nums">
								{fontSize} px
							</span>
							<button
								type="button"
								aria-label="增大字号"
								onClick={() => {
									const next = Math.min(
										UI_FONT_SIZES[UI_FONT_SIZES.length - 1] ?? 16,
										fontSize + 1,
									);
									changeFontSize(next);
								}}
								className="flex size-6 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
							>
								<Plus className="size-3" />
							</button>
						</div>
					</SettingRow>
					<SettingRow title="字体" description="正文与界面使用系统字体；自定义字体尚未接入。">
						<Badge>系统默认</Badge>
					</SettingRow>
				</SettingsCard>
				<div className="rounded-[16px] border-[0.5px] border-border bg-card px-4 py-3.5">
					<div className="text-[11px] leading-4 text-foreground-subtlest">预览</div>
					<p
						className="m-0 mt-1.5 text-foreground"
						style={{ fontSize: `${fontSize}px`, lineHeight: 1.7 }}
					>
						探索未至之境。输入一句话，Agent 会拆解任务、调用工具并给出可检查的结果。
					</p>
				</div>
			</section>
		</div>
	);
}
