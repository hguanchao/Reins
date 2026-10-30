import {
	CURSOR_DEFAULT,
	DISABLE_BRACKETED_PASTE,
	DISABLE_FOCUS_REPORTING,
	DISABLE_KEYBOARD_PROTOCOL,
	DISABLE_MOUSE,
	LEAVE_ALTERNATE_SCREEN,
	SHOW_CURSOR,
} from "#src/tui/terminal.ts";
import type { TuiState } from "#src/tui/runtime/types.ts";
import type { TuiOptions } from "#src/tui/options.ts";

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

/** 需要走同一套收尾流程的终止信号。SIGKILL 拦不住，其余常见的都在这里。 */
export const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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

	try {
		// 审批与审查都可能还在等：无论哪条路径退出，都要把它们交回/中止。
		// 审查不是回合，只 abort activeTurn 会让子代理继续请求并写已关闭的会话。
		options.approval?.denyAll();
		if (state.activeTurn !== undefined) state.activeTurn.controller.abort("session");
		state.reviewAbort?.abort();
		state.reviewAbort = undefined;
		if (state.exitTimer !== undefined) {
			clearTimeout(state.exitTimer);
			state.exitTimer = undefined;
		}
		if (state.escClearTimer !== undefined) {
			clearTimeout(state.escClearTimer);
			state.escClearTimer = undefined;
		}
		if (state.spinnerTimer !== undefined) {
			clearInterval(state.spinnerTimer);
			state.spinnerTimer = undefined;
		}
		if (state.statusClearTimer !== undefined) {
			clearTimeout(state.statusClearTimer);
			state.statusClearTimer = undefined;
		}
		if (state.inputTailTimer !== undefined) {
			clearTimeout(state.inputTailTimer);
			state.inputTailTimer = undefined;
		}
		if (state.pastingTimer !== undefined) {
			clearTimeout(state.pastingTimer);
			state.pastingTimer = undefined;
		}
		if (state.copyNoticeTimer !== undefined) {
			clearTimeout(state.copyNoticeTimer);
			state.copyNoticeTimer = undefined;
		}
		state.stdout.off("resize", deps.render);
		state.stdin.off("data", deps.onData);
		for (const signal of EXIT_SIGNALS) process.off(signal, deps.onInterrupt);
		state.stdin.setRawMode?.(false);
		state.stdin.pause();
		state.stdout.write(
			DISABLE_KEYBOARD_PROTOCOL +
				DISABLE_BRACKETED_PASTE +
				DISABLE_MOUSE +
				DISABLE_FOCUS_REPORTING +
				CURSOR_DEFAULT +
				SHOW_CURSOR +
				LEAVE_ALTERNATE_SCREEN,
		);
	} finally {
		// 收尾中途抛错（终端已关闭时的写失败、插件在 shutdown 里抛错）也必须让 runTui 落定，
		// 否则进程会带着「已 finished」的状态挂住，调用方的 finally 也永远不执行
		state.finish();
	}
}
