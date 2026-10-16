import type { NotifyMode } from "../../config/config-file.ts";

/**
 * 完成提醒。
 *
 * 只在「人不在看这个窗口」时提醒：一直盯着屏幕还被响铃打断，只会让人把这个功能关掉。判断
 * 依据是终端的上报——它会在窗口失去焦点时通知我们。
 *
 * 终端不上报焦点时按「在看」处理，一律不提醒：宁可不响，也不要在每次回答结束时都响一声。
 */

export type NotifyAction = "none" | "bell" | "desktop";

export interface NotifyOptions {
	readonly mode: NotifyMode;
	/** 终端是否已经失去焦点；undefined 表示终端不上报，按还在看着处理。 */
	readonly focused: boolean | undefined;
	/** 终端认不认桌面通知 */
	readonly desktopSupported: boolean;
}

export function decideNotify(options: NotifyOptions): NotifyAction {
	if (options.mode === "off") return "none";
	if (options.focused !== false) return "none";

	switch (options.mode) {
		case "bell":
			return "bell";
		case "desktop":
			return "desktop";
		default:
			// auto：能弹通知就弹，不能就响一声
			return options.desktopSupported ? "desktop" : "bell";
	}
}

/**
 * 提醒对应的控制序列。
 *
 * 桌面通知用 OSC 9，它是几个主流终端共同接受的写法。桌面通知失败也不会有什么后果，
 * 因此不值得为它再探测一次终端能力。
 */
export function notificationSequence(action: NotifyAction, message: string): string {
	if (action === "bell") return "\x07";
	if (action === "desktop") return `\x1b]9;${message}\x07`;
	return "";
}

/**
 * 终端是否支持桌面通知。
 *
 * 只认确定支持的几个：认不出来就不发，否则终端会把这段序列当普通字符画在屏幕上，留下一串
 * 乱码比不提醒更糟。
 */
export function desktopNotificationsSupported(env: Readonly<Record<string, string | undefined>>): boolean {
	if (env["WT_SESSION"] !== undefined) return true;

	switch (env["TERM_PROGRAM"]) {
		case "iTerm.app":
		case "WezTerm":
		case "vscode":
		case "ghostty":
		case "Hyper":
			return true;
		default:
			return false;
	}
}
