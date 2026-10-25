import { StringDecoder } from "node:string_decoder";

import { inputView } from "../footer.ts";
import { createBuiltinCommands } from "../commands.ts";
import type { TuiOptions } from "../options.ts";
import { APPROVAL_MODES } from "../../config/config-file.ts";
import type { TuiState } from "./types.ts";

/** 按启动选项造出初始状态；历史与任务表由调用方先行灌入。 */
export function createState(options: TuiOptions): TuiState {
	return {
		stdin: options.stdin ?? process.stdin,
		stdout: options.stdout ?? process.stdout,
		ready: options.ready ?? true,
		activeWarning: options.warning,
		sandboxNotice: options.sandbox?.warning,
		builtinCommands: createBuiltinCommands(options),
		input: "",
		inputCursor: 0,
		pendingImages: [],
		imageLoading: false,
		attachmentEpoch: 0,
		queued: [],
		sendQueuedAfterAbort: false,
		inputHistory: [],
		historyIndex: -1,
		historyDraft: "",
		pasting: false,
		turns: (options.history ?? []).map((turn) => ({
			prompt: turn.prompt,
			response: [...turn.response],
		})),
		currentTodo: options.historyTodo,
		hasInput: (options.history?.length ?? 0) > 0,
		pendingCommandTurns: [],
		initialScroll: (options.history?.length ?? 0) > 0,
		focused: true,
		scrollTop: 0,
		lastClick: undefined,
		follow: true,
		transcriptView: undefined,
		transcriptViewWidth: -1,
		transcriptViewNotice: undefined,
		transcriptDirty: true,
		draggingScrollbar: false,
		buttonHovered: false,
		decoder: new StringDecoder("utf8"),
		statusText: undefined,
		statusTone: undefined,
		statusPhaseMs: 0,
		statusElapsedMs: 0,
		statusTokens: 0,
		statusPhaseStartedAt: 0,
		spinnerFrame: 0,
		sweepPhase: 0,
		activeTurn: undefined,
		approvalPrompt: undefined,
		approvalSelection: "once",
		modelMenu: undefined,
		effortMenu: undefined,
		sessionMenu: undefined,
		commandMenu: undefined,
		commandMenuDismissed: false,
		fileMenu: undefined,
		fileMenuDismissed: false,
		fileFiles: undefined,
		fileIndexStart: undefined,
		openPage: undefined,
		pageScrollTop: 0,
		planReview: undefined,
		latestPlan: options.historyPlan,
		pendingPlan: undefined,
		checkpointList: [],
		checkpointCursor: 0,
		checkpointPreview: undefined,
		checkpointReturnToList: false,
		checkpointLoading: false,
		restoringCheckpoint: false,
		jobCursor: 0,
		jobDetailId: undefined,
		jobReturnToList: false,
		pageCache: undefined,
		spinnerTimer: undefined,
		jobTimer: undefined,
		unsubscribeJobs: () => {},
		statusClearTimer: undefined,
		exitArmed: false,
		exitTimer: undefined,
		finished: false,
		finish: () => {},
	};
}

/** 输入框里命中的命令名长度；只用于给已注册的命令着色。 */
export function typedCommandLength(state: TuiState, commands: readonly { name: string }[]): number {
	const input = state.input;
	if (!input.startsWith("/")) return 0;
	const name = input.slice(1).split(" ")[0] ?? "";
	return commands.some((item) => item.name === name) ? name.length + 1 : 0;
}

/** 动作行当前可选的审批结论；没有保存范围时没有 always。 */
export function approvalActions(saveShort: string | undefined): readonly string[] {
	return saveShort === undefined ? ["once", "deny"] : ["once", "always", "deny"];
}

/** 输入框的行数与列宽；光标定位与点击命中都用这一份。 */
export function inputMetrics(state: TuiState, width: number): ReturnType<typeof inputView> {
	return inputView(state.input, width, state.inputCursor);
}

/** 允许的最高审批档位在列表里的下一档。 */
export function nextApprovalMode(current: string): string {
	const index = APPROVAL_MODES.indexOf(current as (typeof APPROVAL_MODES)[number]);
	return APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] ?? "ask";
}
