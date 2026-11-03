import { useCallback, useEffect, useMemo, useState } from "react";

import { desktopBridge } from "../platform.ts";

/**
 * 主题。
 *
 * 只有两套实际主题（Zai Light / Zai Dark），System 是选择方式而不是第三套配色。
 * 首次启动默认跟随系统；选择存在 localStorage，桌面壳同步窗口底色。
 */

export type ThemeMode = "zai-dark" | "zai-light" | "system";
export type ResolvedTheme = "zai-dark" | "zai-light";

const STORAGE_KEY = "reins-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function readThemeMode(): ThemeMode {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "zai-light" || stored === "zai-dark" || stored === "system") return stored;
	} catch {
		// 隐私模式或禁用存储时按默认跟随系统处理
	}
	return "system";
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
	if (mode !== "system") return mode;
	return window.matchMedia(DARK_QUERY).matches ? "zai-dark" : "zai-light";
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
	const resolved = resolveTheme(mode);
	const root = document.documentElement;
	root.dataset.theme = resolved;
	root.classList.toggle("dark", resolved === "zai-dark");
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute("content", resolved === "zai-dark" ? "#161616" : "#f8f8f8");
	desktopBridge()?.setTheme(resolved);
	return resolved;
}

export function writeThemeMode(mode: ThemeMode): void {
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {
		// 存不下就只在本次生效，不因为存储失败打断主题切换
	}
}

export function useTheme(): {
	readonly mode: ThemeMode;
	readonly resolved: ResolvedTheme;
	setMode(mode: ThemeMode): void;
	toggle(): void;
} {
	const [mode, setModeState] = useState<ThemeMode>(readThemeMode);
	const resolved = useMemo(() => resolveTheme(mode), [mode]);

	useEffect(() => {
		applyTheme(mode);
	}, [mode]);

	useEffect(() => {
		if (mode !== "system") return;
		const query = window.matchMedia(DARK_QUERY);
		const onChange = (): void => {
			applyTheme("system");
		};
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, [mode]);

	const setMode = useCallback((next: ThemeMode): void => {
		writeThemeMode(next);
		setModeState(next);
	}, []);

	const toggle = useCallback((): void => {
		setModeState((current) => {
			const next: ThemeMode = resolveTheme(current) === "zai-dark" ? "zai-light" : "zai-dark";
			writeThemeMode(next);
			return next;
		});
	}, []);

	return { mode, resolved, setMode, toggle };
}
