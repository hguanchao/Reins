import {
	CURSOR_DEFAULT,
	DISABLE_BRACKETED_PASTE,
	DISABLE_FOCUS_REPORTING,
	DISABLE_MOUSE,
	LEAVE_ALTERNATE_SCREEN,
	SHOW_CURSOR,
} from "../terminal.ts";
import type { TuiState } from "./types.ts";
import type { TuiOptions } from "../options.ts";

/**
 * 退出确认与收尾。
 *
 * 空闲时连按两次 Ctrl+C 才离开：第一次只是武装，2 秒内没有第二次就解除。退出确认
 * 只在这一处实现，中断键、SIGINT 与异常路径共用。
 */

export function disarm(state: TuiState): void {
	if (state.exitTimer !== undefined) {
		clearTimeout(state.exitTimer);
		state.exitTimer = undefined;
	}
	state.exitArmed = false;
}

/** 武装退出确认:2 秒内再按一次 Ctrl+C 才真正离开。 */
export function armExit(state: TuiState, disarmFn: () => void, windowMs: number): void {
	state.exitArmed = true;
	state.exitTimer = setTimeout(disarmFn, windowMs);
}

/** 释放所有定时器、订阅与终端状态，然后让 runTui 的 Promise 落定。 */
export function cleanup(
	state: TuiState,
	options: TuiOptions,
	deps: {
		readonly render: () => void;
		readonly onData: (chunk: Buffer) => void;
		readonly onInterrupt: () => void;
	},
): void {
	if (state.finished) return;
	state.finished = true;

	if (state.activeTurn !== undefined) {
		options.approval?.denyAll();
		state.activeTurn.controller.abort();
	}
	if (state.exitTimer !== undefined) {
		clearTimeout(state.exitTimer);
		state.exitTimer = undefined;
	}
	if (state.spinnerTimer !== undefined) {
		clearInterval(state.spinnerTimer);
		state.spinnerTimer = undefined;
	}
	if (state.jobTimer !== undefined) {
		clearInterval(state.jobTimer);
		state.jobTimer = undefined;
	}
	state.unsubscribeJobs();
	options.jobs?.shutdown();
	if (state.statusClearTimer !== undefined) {
		clearTimeout(state.statusClearTimer);
		state.statusClearTimer = undefined;
	}
	if (state.copyNoticeTimer !== undefined) {
		clearTimeout(state.copyNoticeTimer);
		state.copyNoticeTimer = undefined;
	}
	state.stdout.off("resize", deps.render);
	state.stdin.off("data", deps.onData);
	process.off("SIGINT", deps.onInterrupt);
	state.stdin.setRawMode?.(false);
	state.stdin.pause();
	state.stdout.write(
		DISABLE_BRACKETED_PASTE +
			DISABLE_MOUSE +
			DISABLE_FOCUS_REPORTING +
			CURSOR_DEFAULT +
			SHOW_CURSOR +
			LEAVE_ALTERNATE_SCREEN,
	);
	state.finish();
}
