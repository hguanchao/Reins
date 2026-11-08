/**
 * 界面偏好。
 *
 * 只存本机、只影响观感：减少动效、等宽连字、工具卡默认展开。与 config.toml 里的运行参数
 * 分开——这些不该跟着项目走，也不该让内核知道。
 *
 * 生效路径统一走根节点属性：main.tsx 在首帧前落一次，设置页每次改动再落一次，
 * CSS 与组件都从 dataset 读，不需要把偏好逐层透传。
 */

const KEYS = {
	reduceMotion: "reins-reduce-motion",
	ligatures: "reins-mono-ligatures",
	toolExpand: "reins-tool-expand",
} as const;

function read(key: string, fallback: boolean): boolean {
	try {
		const value = localStorage.getItem(key);
		if (value === "1") return true;
		if (value === "0") return false;
	} catch {
		// 存储不可用时用默认值
	}
	return fallback;
}

function write(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, value ? "1" : "0");
	} catch {
		// 存不下就只在本次生效
	}
}

export interface Preferences {
	readonly reduceMotion: boolean;
	readonly ligatures: boolean;
	readonly toolExpand: boolean;
}

export function readPreferences(): Preferences {
	return {
		reduceMotion: read(KEYS.reduceMotion, false),
		ligatures: read(KEYS.ligatures, true),
		toolExpand: read(KEYS.toolExpand, false),
	};
}

/** 偏好落到根节点：CSS 用属性选择器接住，组件不必逐层透传。 */
export function applyPreferences(preferences: Preferences): void {
	const root = document.documentElement;
	root.dataset.reduceMotion = preferences.reduceMotion ? "true" : "false";
	root.dataset.ligatures = preferences.ligatures ? "true" : "false";
	root.dataset.toolExpand = preferences.toolExpand ? "true" : "false";
}

/** 工具卡挂载时的初始展开态；切换偏好只影响之后新挂载的卡片。 */
export function toolCardsExpanded(): boolean {
	return document.documentElement.dataset.toolExpand === "true";
}

export function savePreference(key: keyof Preferences, value: boolean): void {
	const storageKey =
		key === "reduceMotion" ? KEYS.reduceMotion : key === "ligatures" ? KEYS.ligatures : KEYS.toolExpand;
	write(storageKey, value);
}
