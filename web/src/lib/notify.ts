import { desktopBridge } from "../platform.ts";

export { shouldNotify } from "./notify-mode.ts";

/** 只有桌面壳提供通知桥；浏览器里没有桥，直接忽略。 */
export function sendDesktopNotification(title: string, body: string): void {
	const bridge = desktopBridge();
	if (bridge === undefined) return;
	void bridge.notify({ title, body });
}
