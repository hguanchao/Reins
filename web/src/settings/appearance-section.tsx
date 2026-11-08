import { useState, type ReactElement } from "react";

import { Switch } from "../components/ui/index.ts";
import { applyPreferences, readPreferences, savePreference, type Preferences } from "../state/preferences.ts";
import type { ThemeMode } from "../state/theme.ts";
import { applyUiFontSize, readUiFontSize, UI_FONT_SIZES } from "../state/ui-font.ts";
import { Section, SettingsPane } from "./controls.tsx";

const THEMES: readonly { readonly mode: ThemeMode; readonly label: string; readonly dataTheme: string | undefined }[] = [
	{ mode: "system", label: "跟随系统", dataTheme: undefined },
	{ mode: "zai-light", label: "浅色", dataTheme: "zai-light" },
	{ mode: "zai-dark", label: "深色", dataTheme: "zai-dark" },
];

/**
 * 外观。
 *
 * 主题用三张微缩界面缩略图——直接看见结果，不用色块；字号用滑杆 + 实时预览；动效与连字
 * 用开关，默认值由本机偏好决定。设置即时生效，只保留一个「恢复默认」。
 */
export function AppearanceSection({
	themeMode,
	onThemeMode,
}: {
	readonly themeMode: ThemeMode;
	onThemeMode(mode: ThemeMode): void;
}): ReactElement {
	const [fontSize, setFontSize] = useState(readUiFontSize);
	const [preferences, setPreferences] = useState<Preferences>(readPreferences);

	const changeFontSize = (next: number): void => {
		setFontSize(next);
		applyUiFontSize(next);
	};

	const toggle = (key: keyof Preferences, value: boolean): void => {
		const next = { ...preferences, [key]: value };
		setPreferences(next);
		savePreference(key, value);
		applyPreferences(next);
	};

	const index = Math.max(0, UI_FONT_SIZES.indexOf(fontSize as (typeof UI_FONT_SIZES)[number]));
	const ratio = index / Math.max(1, UI_FONT_SIZES.length - 1);

	return (
		<SettingsPane
			eyebrow="SETTINGS / APPEARANCE"
			title="外观"
			description="主题、字号与动效。改动立即生效，不需要重启。"
		>
			<Section name="主题">
				<div className="theme-grid">
					{THEMES.map((theme) => (
						<button
							key={theme.mode}
							type="button"
							className="theme-card"
							aria-pressed={themeMode === theme.mode}
							onClick={() => onThemeMode(theme.mode)}
						>
							<span className="theme-thumb" data-theme={theme.dataTheme}>
								<span className="rail" />
								<span className="body">
									<span className="l1" style={{ display: "block" }} />
									<span className="l2" style={{ display: "block" }} />
									<span className="l3" style={{ display: "block" }} />
									<span className="box" style={{ display: "block" }} />
								</span>
							</span>
							<span className="cap">
								{themeMode === theme.mode ? (
									<svg
										className="ic-12"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<path d="M20 6 9 17l-5-5" />
									</svg>
								) : null}
								{theme.label}
							</span>
						</button>
					))}
				</div>
			</Section>

			<Section name="界面字号" hint="只影响对话与界面文字，代码与终端字号不变">
				<div className="slider-row">
					<div className="slider">
						<span className="track" />
						<span className="fill" style={{ width: `${ratio * 100}%` }} />
						{UI_FONT_SIZES.map((size, position) => (
							<span
								key={size}
								style={{
									position: "absolute",
									left: `${(position / Math.max(1, UI_FONT_SIZES.length - 1)) * 100}%`,
									top: -3,
									width: 1,
									height: 7,
									background: "var(--rule-2)",
								}}
							/>
						))}
						<span className="knob" style={{ left: `${ratio * 100}%` }} />
						<input
							type="range"
							min={0}
							max={UI_FONT_SIZES.length - 1}
							step={1}
							value={index}
							aria-label="界面字号"
							onChange={(event) => {
								const next = UI_FONT_SIZES[Number(event.target.value)];
								if (next !== undefined) changeFontSize(next);
							}}
							style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
						/>
					</div>
					<span className="num" style={{ minWidth: 44, textAlign: "right", fontSize: "var(--fs-11)" }}>
						{fontSize} px
					</span>
				</div>
				<div className="slider-ticks">
					{UI_FONT_SIZES.map((size) => (
						<span key={size}>{size}</span>
					))}
				</div>
				<div className="preview-box">
					这是一段预览文字。所有文件工具在访问前都先校验目标是否落在工作区根目录内。
				</div>
			</Section>

			<div className="switch-rows">
				<div className="switch-row">
					<div className="txt">
						<div className="t">减少动效</div>
						<div className="d">关闭过渡、折叠与呼吸动画，界面切换瞬时完成。</div>
					</div>
					<Switch
						checked={preferences.reduceMotion}
						onCheckedChange={(value) => toggle("reduceMotion", value)}
						label="减少动效"
					/>
				</div>
				<div className="switch-row">
					<div className="txt">
						<div className="t">工具卡默认展开</div>
						<div className="d">执行中的工具卡自动展开输出，完成后收起。</div>
					</div>
					<Switch
						checked={preferences.toolExpand}
						onCheckedChange={(value) => toggle("toolExpand", value)}
						label="工具卡默认展开"
					/>
				</div>
				<div className="switch-row">
					<div className="txt">
						<div className="t">等宽字体连字</div>
						<div className="d">代码块中启用 → ⇒ ≥ 等连字，需要字体支持。</div>
					</div>
					<Switch
						checked={preferences.ligatures}
						onCheckedChange={(value) => toggle("ligatures", value)}
						label="等宽字体连字"
					/>
				</div>
			</div>

			<div style={{ marginTop: 26, display: "flex", gap: 8 }}>
				<button
					type="button"
					className="b b-line"
					onClick={() => {
						changeFontSize(14);
						const next: Preferences = { reduceMotion: false, ligatures: true, toolExpand: false };
						setPreferences(next);
						applyPreferences(next);
						savePreference("reduceMotion", false);
						savePreference("ligatures", true);
						savePreference("toolExpand", false);
					}}
				>
					恢复默认
				</button>
			</div>
		</SettingsPane>
	);
}
