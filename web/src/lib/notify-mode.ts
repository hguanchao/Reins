import type { NotifyMode } from "../protocol.ts";

/**
 * 是否弹桌面通知。
 *
 * bell 是终端专用，桌面壳里没有对应的声音；auto 只在窗口失焦时提醒，desktop 则总是提醒。
 * 单独放一个模块，测试与纯逻辑不必把桌面桥拖进来。
 */
export function shouldNotify(mode: NotifyMode, focused: boolean): boolean {
	if (mode === "off" || mode === "bell") return false;
	if (mode === "auto") return !focused;
	return true;
}
