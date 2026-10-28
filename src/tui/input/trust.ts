import { approvalKey, menuKey } from "./keys.ts";
import type { InputDeps } from "./deps.ts";
import type { TuiHost } from "../runtime/types.ts";
import type { TrustAnswer } from "../page/trust.ts";

/** 选项顺序：左右键按它移动，最后一项是不信任。 */
const ORDER: readonly TrustAnswer[] = ["trust", "session", "skip"];

/**
 * 信任页的按键。
 *
 * 三个字母与三档一一对应（y / s / n），左右键只负责移动高亮、回车确认，Esc 直接不信任。
 * 不设上下键：底部选项是横排的，左右才是它对应的方向。
 */
export function handleTrustInput(host: TuiHost, deps: InputDeps, text: string): void {
	const prompt = host.state.trustPrompt;
	if (prompt === undefined || prompt.pending) return;

	const nav = menuKey(text);
	if (nav === "enter") return host.resolveTrust(prompt.selection);
	if (nav === "escape") return host.resolveTrust("skip");

	// 精确匹配单个字母：粘贴或组合键里的零散字符不该触发结论
	if (text.toLowerCase() === "s") return host.resolveTrust("session");

	// 左右键与 y / n 走审批卡那一套解析：两个面板的按键习惯保持一致
	const choice = approvalKey(text, false);
	if (choice === "left") move(host, deps, -1);
	else if (choice === "right") move(host, deps, 1);
	else if (choice === "once") host.resolveTrust("trust");
	else if (choice === "deny") host.resolveTrust("skip");
}

function move(host: TuiHost, deps: InputDeps, delta: number): void {
	const prompt = host.state.trustPrompt;
	if (prompt === undefined) return;
	const index = ORDER.indexOf(prompt.selection);
	const next = ORDER[(index + delta + ORDER.length) % ORDER.length];
	if (next === undefined) return;
	prompt.selection = next;
	deps.render();
}
