import { approvalKey } from "./keys.ts";
import type { InputDeps } from "./deps.ts";
import type { TuiHost } from "../runtime/types.ts";

/**
 * 信任页的按键。
 *
 * 只有三种结果：授予、跳过、退出。授予写成 y 与回车（默认高亮），跳过写成 n 与 Esc，
 * 与审批卡保持同一套习惯——不需要为一个只在启动时出现一次的页面重新学一遍。
 */
export function handleTrustInput(host: TuiHost, deps: InputDeps, text: string): void {
	const prompt = host.state.trustPrompt;
	if (prompt === undefined || prompt.pending) return;

	const key = approvalKey(text, false);
	if (key === "left" || key === "right") {
		prompt.selection = prompt.selection === "trust" ? "skip" : "trust";
		deps.render();
		return;
	}
	if (key === "escape" || key === "deny") {
		host.resolveTrust(false);
		return;
	}
	if (key === "enter") {
		host.resolveTrust(prompt.selection === "trust");
		return;
	}
	if (key === "once") host.resolveTrust(true);
}
