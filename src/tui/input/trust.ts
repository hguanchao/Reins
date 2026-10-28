import { approvalKey, menuKey } from "./keys.ts";
import type { InputDeps } from "./deps.ts";
import type { TuiHost } from "../runtime/types.ts";
import type { TrustAnswer } from "../page/trust.ts";

/** 选项顺序：上下键按它移动，最后一项是不信任。 */
const ORDER: readonly TrustAnswer[] = ["trust", "session", "skip"];

/**
 * 信任页的按键。
 *
 * 上下（或左右）移动、回车确认、Esc 直接不信任，与参考实现的对话框保持同一套习惯；
 * 数字 1/2/3 可以一步选到对应项，省去在三个选项之间挪动。
 */
export function handleTrustInput(host: TuiHost, deps: InputDeps, text: string): void {
	const prompt = host.state.trustPrompt;
	if (prompt === undefined || prompt.pending) return;

	const digit = /^([1-3])$/.exec(text)?.[1];
	if (digit !== undefined) {
		const answer = ORDER[Number(digit) - 1];
		if (answer !== undefined) host.resolveTrust(answer);
		return;
	}

	const nav = menuKey(text);
	if (nav === "up") return move(host, deps, -1);
	if (nav === "down") return move(host, deps, 1);
	if (nav === "enter") return host.resolveTrust(prompt.selection);
	if (nav === "escape") return host.resolveTrust("skip");

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

