import { desktopBridge } from "../platform.ts";

export { shouldNotify } from "./notify-mode.ts";

/** 系统通知统一交给桌面壳。 */
export function sendDesktopNotification(title: string, body: string): void {
	void desktopBridge().notify({ title, body });
}
