import { useState, type ReactElement } from "react";

import { Switch } from "../components/ui/index.ts";
import { applyPreferences, readPreferences, savePreference, type Preferences } from "../state/preferences.ts";
import type { ThemeMode } from "../state/theme.ts";
import {
	applyCodeFontSize,
	applyUiFontSize,
	CODE_FONT_SIZES,
	DEFAULT_CODE_FONT_SIZE,
	DEFAULT_UI_FONT_SIZE,
	readCodeFontSize,
	readUiFontSize,
	UI_FONT_SIZES,
} from "../state/ui-font.ts";
import { SettingsPane } from "./controls.tsx";

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
	const [codeSize, setCodeSize] = useState(readCodeFontSize);
	const [preferences, setPreferences] = useState<Preferences>(readPreferences);

	const changeFontSize = (next: number): void => {
		setFontSize(next);
		applyUiFontSize(next);
	};

	const changeCodeSize = (next: number): void => {
		setCodeSize(next);
		applyCodeFontSize(next);
	};

	const toggle = (key: keyof Preferences, value: boolean): void => {
		const next = { ...preferences, [key]: value };
		setPreferences(next);
		savePreference(key, value);
		applyPreferences(next);
	};

	return (
		<SettingsPane
			eyebrow="SETTINGS / APPEARANCE"
			title="外观"
			description="主题、字号与动效。改动立即生效，不需要重启。"
		>
			<div className="mono-label" style={{ fontSize: 9, marginBottom: 10, marginTop: 26 }}>
				主题
			</div>
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
										className="ic ic-12"
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

			<div className="mono-label" style={{ fontSize: 9, marginBottom: 10, marginTop: 28 }}>
				界面字号
			</div>
			<div>
				<FontSlider
					label="界面字号"
					sizes={UI_FONT_SIZES}
					value={fontSize}
					onChange={changeFontSize}
				/>
			</div>

			<div className="mono-label" style={{ fontSize: 9, marginBottom: 10, marginTop: 22 }}>
				代码字号
			</div>
			<div>
				<FontSlider
					label="代码字号"
					sizes={CODE_FONT_SIZES}
					value={codeSize}
					onChange={changeCodeSize}
				/>
				<div className="preview-box">
					这是一段预览文字。所有文件工具在访问前都先校验目标是否落在工作区根目录内。
				</div>
			</div>

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
						changeFontSize(DEFAULT_UI_FONT_SIZE);
						changeCodeSize(DEFAULT_CODE_FONT_SIZE);
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

/** 字号滑杆：离散档位 + 刻度读数，两档字号（界面/代码）共用同一形态。 */
function FontSlider({
	label,
	sizes,
	value,
	onChange,
}: {
	readonly label: string;
	readonly sizes: readonly number[];
	readonly value: number;
	onChange(next: number): void;
}): ReactElement {
	const index = Math.max(0, sizes.indexOf(value));
	const ratio = index / Math.max(1, sizes.length - 1);
	return (
		<>
			<div className="slider-row">
				<div className="slider">
					<span className="track" />
					<span className="fill" style={{ width: `${ratio * 100}%` }} />
					{sizes.map((size, position) => (
						<span
							key={size}
							style={{
								position: "absolute",
								left: `${(position / Math.max(1, sizes.length - 1)) * 100}%`,
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
						max={sizes.length - 1}
						step={1}
						value={index}
						aria-label={label}
						onChange={(event) => {
							const next = sizes[Number(event.target.value)];
							if (next !== undefined) onChange(next);
						}}
						style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
					/>
				</div>
				<span className="num" style={{ minWidth: 44, textAlign: "right", fontSize: "var(--fs-11)" }}>
					{value} px
				</span>
			</div>
			<div className="slider-ticks">
				{sizes.map((size) => (
					<span key={size}>{size}</span>
				))}
			</div>
		</>
	);
}
