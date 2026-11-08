import { useEffect } from "react";

import { approvalShortcut, type PendingGate } from "./approval-shortcut.ts";
import type { ApprovalAnswer, ThinkingLevel } from "../protocol.ts";

/**
 * 全局快捷键。
 *
 * 设置页占满窗口时整组停用，后台会话的快捷键不穿透到被遮住的界面；输入框内的按键
 * 也不参与全局判定。审批裁决的键位映射交给纯函数，高危卡在那里被直接拒绝。
 */

export interface ShortcutContext {
	readonly settingsOpen: boolean;
	readonly running: boolean;
	readonly approval: PendingGate | undefined;
	readonly effort: ThinkingLevel;
	readonly thinkingLevels: readonly ThinkingLevel[];
	onSettings(): void;
	onToggleSidebar(): void;
	onToggleCommand(): void;
	onNewTask(): void;
	onEffort(level: ThinkingLevel): void;
	onStop(): void;
	onAnswer(id: number, value: ApprovalAnswer): void;
}

export function useAppShortcuts(context: ShortcutContext): void {
	const {
		settingsOpen,
		running,
		approval,
		effort,
		thinkingLevels,
		onSettings,
		onToggleSidebar,
		onToggleCommand,
		onNewTask,
		onEffort,
		onStop,
		onAnswer,
	} = context;

	useEffect(() => {
		if (settingsOpen) return;
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const command = event.ctrlKey || event.metaKey;
			const target = event.target as HTMLElement | null;
			const typing = target !== null && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
			if (command && event.key === ",") {
				event.preventDefault();
				onSettings();
				return;
			}
			if (command && event.key.toLowerCase() === "b") {
				event.preventDefault();
				onToggleSidebar();
				return;
			}
			if (command && event.key.toLowerCase() === "k") {
				event.preventDefault();
				onToggleCommand();
				return;
			}
			if (command && event.key.toLowerCase() === "n") {
				event.preventDefault();
				onNewTask();
				return;
			}
			if (command && event.key === "1" && !typing) {
				event.preventDefault();
				if (thinkingLevels.length > 0) {
					const index = thinkingLevels.indexOf(effort);
					const next = thinkingLevels[(index + 1) % thinkingLevels.length];
					if (next !== undefined) onEffort(next);
				}
				return;
			}
			if (event.key === "Escape" && running && !typing) {
				event.preventDefault();
				onStop();
				return;
			}
			if (typing || approval === undefined) return;
			const value = approvalShortcut(event.key, approval.request);
			if (value !== undefined) {
				event.preventDefault();
				onAnswer(approval.id, value);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		approval,
		effort,
		onAnswer,
		onEffort,
		onNewTask,
		onSettings,
		onStop,
		onToggleCommand,
		onToggleSidebar,
		running,
		settingsOpen,
		thinkingLevels,
	]);
}
