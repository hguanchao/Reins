import { ABORTING } from "../render/status.ts";
import { cleanup } from "./lifecycle.ts";
import { closePlanReview } from "./pages.ts";
import { closeCheckpointPage } from "./checkpoints.ts";
import { closeJobPage } from "./jobs.ts";
import { armExit, disarm } from "./lifecycle.ts";
import { EXIT_CONFIRM_WINDOW_MS } from "./constants.ts";
import type { TuiHost } from "./types.ts";

/** Ctrl+C 的三种上下文：运行中中止、整屏页返回、空闲时连按退出。 */
export function onCtrlC(
	host: TuiHost,
	deps: { readonly render: () => void; readonly cleanup: () => void },
): void {
	const state = host.state;
	if (state.activeTurn !== undefined) {
		// 第一次只中止当前轮；2 秒内再按一次强制退出
		if (state.exitArmed) {
			deps.cleanup();
			return;
		}
		armExit(state, () => disarm(state), EXIT_CONFIRM_WINDOW_MS);
		host.options.approval?.denyAll();
		state.activeTurn.controller.abort();
		host.setStatus(ABORTING);
		deps.render();
		return;
	}
	if (state.reviewing) {
		// 审查子代理与普通回合一样：第一次只中止，2 秒内再按一次强制退出
		if (state.exitArmed) {
			deps.cleanup();
			return;
		}
		armExit(state, () => disarm(state), EXIT_CONFIRM_WINDOW_MS);
		state.reviewAbort?.abort();
		host.setStatus("Cancelling review...", "notice");
		deps.render();
		return;
	}
	if (state.openPage !== undefined) {
		// 整屏页是模态视图：第一次按回对话流，连按两次才退出
		if (state.exitArmed) {
			deps.cleanup();
			return;
		}
		if (state.openPage === "plan") closePlanReview(state);
		else if (state.openPage === "checkpoints" || state.openPage === "checkpoint") closeCheckpointPage(host);
		else if (state.openPage === "jobs" || state.openPage === "job") closeJobPage(host);
		else {
			if (state.openPage === "viewer") state.viewer = undefined;
			state.openPage = undefined;
		}
		armExit(state, () => disarm(state), EXIT_CONFIRM_WINDOW_MS);
		deps.render();
		return;
	}
	if (state.exitArmed) {
		deps.cleanup();
		return;
	}
	armExit(state, () => disarm(state), EXIT_CONFIRM_WINDOW_MS);
}

export { cleanup };
