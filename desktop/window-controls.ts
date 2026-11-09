/**
 * 自绘窗控的动作翻译。
 *
 * 渲染层只递交动作名，主进程统一解析并执行；按钮的「最大化 / 还原」分支只在这一处判定，
 * 界面不直接约定 Electron 的方法名，外部传入的未知动作一律不执行。
 */

export type WindowControlAction = "minimize" | "toggle-maximize" | "close";

/** 动作名来自渲染进程，逐个收窄后再落到窗口方法上。 */
export function parseWindowAction(value: unknown): WindowControlAction | undefined {
	if (value === "minimize" || value === "toggle-maximize" || value === "close") return value;
	return undefined;
}

/** 结构签名与 Electron 窗口一致，便于用假窗口独立验证动作分支。 */
export interface WindowControlTarget {
	isMaximized(): boolean;
	minimize(): void;
	maximize(): void;
	unmaximize(): void;
	close(): void;
}

export function applyWindowAction(target: WindowControlTarget, action: WindowControlAction): void {
	if (action === "minimize") {
		target.minimize();
		return;
	}
	if (action === "close") {
		target.close();
		return;
	}
	if (target.isMaximized()) target.unmaximize();
	else target.maximize();
}
