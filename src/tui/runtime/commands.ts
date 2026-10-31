import { THINKING_LEVELS } from "#src/config/file.ts";
import { describeError } from "#src/shared/describe-error.ts";
import type { CommandMenuItem } from "#src/tui/panel/command-menu.ts";
import type { SessionSwitchResult } from "#src/tui/options.ts";
import { implementationPrompt } from "#src/tui/render/status.ts";
import {
	FAILURE_ACTIONS,
	FORK_WORKSPACE_NOTE,
	NO_MODELS,
	REVISE_PLAN_PREFIX,
	STATUS,
	commandFailed,
	commandFinished,
	commandRunning,
	failure,
	forkedSession,
	reviewBlocks,
	reviewResult,
	switchedSession,
	unknownEffort,
	unknownModel,
	waitForTurn,
} from "#src/tui/copy.ts";
import { markTranscriptDirty } from "#src/tui/runtime/transcript-state.ts";
import { closePlanReview, closePlanReviewAndResume, showPage } from "#src/tui/runtime/pages.ts";
import {
	openEffortMenu,
	openModelMenu,
	openSessionMenu,
	selectEffort,
	selectModel,
} from "#src/tui/runtime/panels.ts";
import { startRun } from "#src/tui/runtime/run.ts";
import type { TuiHost } from "#src/tui/runtime/types.ts";

/**
 * 斜杠命令的执行。
 *
 * 每条命令一个处理器；分派表只按名字查表，新增命令加一个条目即可。命令回复作为
 * 一条对话记录追加，不进入模型回合。
 */

export function executeCommand(host: TuiHost, command: CommandMenuItem, args = ""): void {
	const state = host.state;
	state.commandMenu = undefined;
	// 与 Tab 补全保持一致：命令名后留一个空格，方便继续输入参数；
	// 面板打开期间也看得清当前执行的是哪条命令
	host.setInput(`/${command.name} `);

	const handlers: Readonly<Record<string, () => void>> = {
		model: () => executeModelCommand(host, args),
		effort: () => executeEffortCommand(host, args),
		session: () => executeSessionCommand(host, args),
		export: () => executeExportCommand(host, args),
		review: () => executeReviewCommand(host, args),
		compact: () => executeCompactCommand(host),
		plan: () => executePlanCommand(host, args),
		undo: () => executeUndoCommand(host),
		help: () => showPage(state, "help"),
		skills: () => showPage(state, "skills"),
		mcps: () => showPage(state, "mcps"),
	};
	const handler = Object.hasOwn(handlers, command.name) ? handlers[command.name] : undefined;
	if (handler !== undefined) {
		// 整屏页期间输入框不接受按键，命令名一律不留在输入框里
		if (
			command.name === "help" ||
			command.name === "skills" ||
			command.name === "mcps"
		) {
			host.setInput("");
		}
		handler();
		host.render();
		return;
	}

	// 插件命令可能有任意副作用，Plan 模式下一律不执行
	if (host.planning()) {
		host.setInput("");
		host.resetStatusMeta();
		host.setStatus(STATUS.pluginCommandsInPlan, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	// 未覆盖的插件命令交给宿主执行
	host.setInput("");
	if (host.options.pluginCommands !== undefined) {
		runPluginCommand(host, command, args);
		return;
	}
	host.render();
}

/**
 * 执行插件/宿主命令。
 *
 * 命令不产生模型事件，因此单独建一条对话流记录；print 的输出原样放进去，失败按错误行显示。
 */
function runPluginCommand(host: TuiHost, command: CommandMenuItem, args: string): void {
	const source = host.options.pluginCommands;
	if (source === undefined) return;

	const state = host.state;
	const turn = { prompt: `/${command.name}`, response: [] as import("#src/tui/transcript.ts").TranscriptLine[] };
	state.turns.push(turn);
	markTranscriptDirty(state);
	state.hasInput = true;
	state.follow = true;
	host.resetStatusMeta();
	if (state.statusClearTimer !== undefined) {
		clearTimeout(state.statusClearTimer);
		state.statusClearTimer = undefined;
	}
	host.setStatus(commandRunning(command.name));
	host.render();

	void source
		.run(command.name, args)
		.then((lines) => {
			if (state.finished) return;
			turn.response.push(...lines);
			markTranscriptDirty(state);
			host.clearStatus();
			host.render();
			host.notify(commandFinished(command.name));
		})
		.catch((error) => {
			if (state.finished) return;
			turn.response.push({
				text: `Error: ${describeError(error)}`,
				kind: "error",
			});
			markTranscriptDirty(state);
			host.setStatus(STATUS.error, "error");
			host.render();
			host.notify(commandFailed(command.name));
		});
}

/** /model:无参数开面板,带参数直接选中那个模型。 */
function executeModelCommand(host: TuiHost, args: string): void {
	const source = host.options.modelMenu;
	if (source === undefined) {
		host.setInput("");
		host.resetStatusMeta();
		host.setStatus(STATUS.configurationInvalid, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	const target = args.trim();
	if (target.length === 0) {
		openModelMenu(host);
		return;
	}

	const items = source.list();
	const item = items.find((candidate) => `${candidate.provider}/${candidate.model}` === target);
	if (item === undefined) {
		host.appendCommandTurn("/model", [
			items.length === 0
				? NO_MODELS
				: { kind: "error", text: unknownModel(target) },
		]);
		return;
	}
	host.setInput("");
	selectModel(host, item);
}

/** /effort:无参数开面板,带参数直接选中那一档。 */
function executeEffortCommand(host: TuiHost, args: string): void {
	const source = host.options.effortMenu;
	if (source === undefined) {
		host.setInput("");
		host.resetStatusMeta();
		host.setStatus(STATUS.configurationInvalid, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	const target = args.trim();
	if (target.length === 0) {
		openEffortMenu(host);
		return;
	}

	const level = THINKING_LEVELS.find((candidate) => candidate === target);
	if (level === undefined) {
		host.appendCommandTurn("/effort", [
			{
				kind: "error",
				text: unknownEffort(target, THINKING_LEVELS),
			},
		]);
		return;
	}
	host.setInput("");
	selectEffort(host, level);
}

/** /session:无参数开面板,带参数直接切换到那个会话。 */
function executeSessionCommand(host: TuiHost, args: string): void {
	const source = host.options.sessionMenu;
	if (source === undefined) {
		host.setInput("");
		host.resetStatusMeta();
		host.setStatus(STATUS.sessionStorageUnavailable, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	const target = args.trim();
	if (target.length === 0) {
		openSessionMenu(host);
		return;
	}
	host.setInput("");
	host.switchSession(target);
}

/**
 * 用一段历史替换整段对话流。
 *
 * 切换会话复用了同一套规则；任务表、计划、查看目标与排队消息都属于旧位置，
 * 必须一起换掉。图片附件一律清空：新位置的文件内容与旧位置的附件无关。
 */
function applyConversation(host: TuiHost, result: SessionSwitchResult): void {
	const state = host.state;
	state.turns.length = 0;
	for (const turn of result.history) {
		state.turns.push({ prompt: turn.prompt, response: [...turn.response] });
	}
	// 任务表与计划都属于会话:随历史一起换成新位置的内容
	state.currentTodo = result.todo;
	state.latestPlan = result.plan;
	state.pendingPlan = undefined;
	// Ctrl+G 的目标指向旧位置的工具行，留着只会打开一段已经不在界面上的内容
	state.viewerTool = undefined;	state.selection = undefined;
	if (state.openPage === "plan") closePlanReview(state);
	else state.planReview = undefined;
	markTranscriptDirty(state);
	state.initialScroll = false;
	state.scrollTop = 0;
	state.follow = true;
	state.hasInput = state.turns.length > 0;
	// 旧位置留下的状态/错误不该跟着出现在新位置
	host.clearStatus();
	// 排队消息是发给旧位置的，换位置后没有意义
	state.queued.length = 0;
	state.fileMenu = undefined;
	state.fileFiles = undefined;
	state.fileIndexStart = undefined;
	host.clearAttachments();
}

/**
 * 审查进行中拒绝会写会话的操作。
 *
 * 审查子代理把用量记进当前会话；此时换会话、回退或导出会让两边同时读同一份文件，
 * 或者导出一份正在变化的快照。
 */
function blockedByReview(host: TuiHost, action: string): boolean {
	if (!host.state.reviewing) return false;
	host.resetStatusMeta();
	host.setStatus(reviewBlocks(action), "notice");
	host.scheduleStatusClear();
	host.render();
	return true;
}

/** /export:把当前会话写成 Markdown 或 JSONL。 */
function executeExportCommand(host: TuiHost, args: string): void {
	host.setInput("");
	const source = host.options.exportSession;
	if (source === undefined) {
		host.resetStatusMeta();
		host.setStatus(STATUS.exportUnavailable, "notice");
		host.scheduleStatusClear();
		return;
	}
	if (host.state.activeTurn !== undefined) {
		host.resetStatusMeta();
		host.setStatus(waitForTurn("/export"), "notice");
		host.scheduleStatusClear();
		return;
	}
	if (blockedByReview(host, "/export")) return;

	const target = args.trim();
	host.resetStatusMeta();
	host.setStatus(STATUS.exporting);
	host.render();
	void Promise.resolve()
		.then(() => source.export(target.length === 0 ? undefined : target))
		.then((message) => {
			if (host.state.finished) return;
			host.clearStatus();
			host.appendCommandTurn("/export", [message]);
		})
		.catch((error) => {
			if (host.state.finished) return;
			host.setStatus(STATUS.exportFailed, "error");
			host.appendCommandTurn("/export", [
				{ kind: "error", text: failure(FAILURE_ACTIONS.export, describeError(error)) },
			]);
		});
}

/** /review:在只读子代理里审查当前改动。 */
function executeReviewCommand(host: TuiHost, args: string): void {
	host.setInput("");
	const source = host.options.review;
	if (source === undefined) {
		host.resetStatusMeta();
		host.setStatus(STATUS.reviewUnavailable, "notice");
		host.scheduleStatusClear();
		return;
	}
	if (host.state.activeTurn !== undefined) {
		host.resetStatusMeta();
		host.setStatus(waitForTurn("/review"), "notice");
		host.scheduleStatusClear();
		return;
	}
	if (host.state.reviewing) {
		host.resetStatusMeta();
		host.setStatus(STATUS.reviewAlreadyRunning, "notice");
		host.scheduleStatusClear();
		return;
	}

	const state = host.state;
	const controller = new AbortController();
	state.reviewing = true;
	state.reviewAbort = controller;
	host.resetStatusMeta();
	host.setStatus(STATUS.reviewing);
	host.render();

	void Promise.resolve()
		.then(() =>
			source.run(args, controller.signal, (text) => {
				if (state.finished || !state.reviewing) return;
				host.setStatus(text);
				host.render();
			}),
		)
		.then((result) => {
			if (state.finished) return;
			host.clearStatus();
			host.appendCommandTurn("/review", [
				reviewResult(result.label, result.steps, result.durationMs, result.stopReason),
				"",
				{ kind: "markdown" as const, text: result.report },
			]);
		})
		.catch((error) => {
			if (state.finished) return;
			host.setStatus(STATUS.reviewFailed, "error");
			host.appendCommandTurn("/review", [
				{ kind: "error", text: failure(FAILURE_ACTIONS.review, describeError(error)) },
			]);
		})
		.finally(() => {
			state.reviewing = false;
			state.reviewAbort = undefined;
			if (!state.finished) host.render();
		});
}

/** /compact:立即压缩一轮上下文。 */
function executeCompactCommand(host: TuiHost): void {
	const compact = host.options.agent?.compact;
	host.setInput("");
	if (compact === undefined) {
		host.resetStatusMeta();
		host.setStatus(STATUS.configurationInvalid, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	startRun(host, "/compact", [], compact);
}

/**
 * /plan:开关只读规划。
 *
 * 带任务时开启并直接规划那一轮；不带参数时切换开关。一轮进行中不允许切换，
 * 否则提示词与工具清单会在同一轮里前后不一致。
 */
function executePlanCommand(host: TuiHost, args: string): void {
	const source = host.options.planMode;
	host.setInput("");
	if (source === undefined) {
		host.resetStatusMeta();
		host.setStatus(STATUS.planUnavailable, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	if (host.state.activeTurn !== undefined) {
		host.resetStatusMeta();
		host.setStatus(waitForTurn("/plan"), "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	const task = args.trim();
	const enabled = task.length > 0 || !source.current();
	try {
		if (source.current() !== enabled) source.select(enabled);
	} catch (error) {
		host.resetStatusMeta();
		host.setStatus(failure(FAILURE_ACTIONS.planSwitch, describeError(error)), "error");
		host.scheduleStatusClear();
		return;
	}

	if (task.length > 0) {
		host.launch(task);
		return;
	}
	// 模式本身由徽标表达；状态行留给这一轮真正的运行状态
	host.clearStatus();
}

function executeUndoCommand(host: TuiHost): void {
	host.setInput("");
	host.runUndo();
}

/** 批准计划：退出 Plan 模式，并把整份计划作为新提示交给模型。 */
export function approvePlan(host: TuiHost): void {
	const plan = host.state.planReview ?? host.state.latestPlan;
	if (plan === undefined) {
		closePlanReviewAndResume(host);
		host.render();
		return;
	}

	// 一轮还在跑时不能再起一轮：历史里的计划卡随时可以双击打开，否则第二个驱动会与
	// 正在跑的那个同时写同一个会话，旧 turn 的流式内容还会被写进新 turn。
	if (host.state.activeTurn !== undefined) {
		closePlanReviewAndResume(host);
		host.resetStatusMeta();
		host.setStatus(STATUS.approveWhileTurn, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	const agent = host.options.agent;
	closePlanReview(host.state);
	if (agent === undefined) {
		closePlanReviewAndResume(host);
		host.resetStatusMeta();
		host.setStatus(STATUS.agentNotConnected, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	try {
		if (host.planning()) host.options.planMode?.select(false);
	} catch (error) {
		closePlanReviewAndResume(host);
		host.resetStatusMeta();
		host.setStatus(failure(FAILURE_ACTIONS.planSwitch, describeError(error)), "error");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	host.setInput("");
	host.launch(implementationPrompt(plan.text));
}

/** 要求修改：关闭审批页，保持或开启 Plan 模式，回到输入框写修改意见。 */
export function revisePlan(host: TuiHost): void {
	closePlanReview(host.state);
	// 与 /plan 同一条约束：提示词与工具清单会在同一轮里前后不一致，不能中途改
	if (host.state.activeTurn !== undefined) {
		host.resetStatusMeta();
		host.setStatus(waitForTurn("Plan mode"), "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	if (!host.planning()) {
		if (host.options.planMode === undefined) {
			host.resetStatusMeta();
			host.setStatus(STATUS.planUnavailable, "notice");
			host.scheduleStatusClear();
			host.render();
			return;
		}
		try {
			host.options.planMode.select(true);
		} catch (error) {
			host.resetStatusMeta();
			host.setStatus(failure(FAILURE_ACTIONS.planSwitch, describeError(error)), "error");
			host.scheduleStatusClear();
			host.render();
			return;
		}
	}

	if (host.state.input.length === 0) host.setInput(REVISE_PLAN_PREFIX);
	host.clearStatus();
	host.render();
}

/** 退出计划：关闭审批页并离开 Plan 模式，计划本身仍可由计划卡回看。 */
export function leavePlan(host: TuiHost): void {
	// 同 /plan：一轮进行中切换会让这一轮后续的工具立刻越过只读闸门
	if (host.state.activeTurn !== undefined) {
		closePlanReviewAndResume(host);
		host.resetStatusMeta();
		host.setStatus(waitForTurn("Plan mode"), "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	const wasPlanning = host.planning();
	closePlanReviewAndResume(host);
	try {
		if (wasPlanning) host.options.planMode?.select(false);
	} catch (error) {
		host.resetStatusMeta();
		host.setStatus(failure(FAILURE_ACTIONS.planSwitch, describeError(error)), "error");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	host.clearStatus();
	host.render();
}

/** 切换后整段对话流都要换掉；旧会话的写入器同时释放。 */
export function switchSession(host: TuiHost, id: string, action: "select" | "fork" = "select"): void {
	const source = host.options.sessionMenu;
	if (source === undefined) return;

	const forking = action === "fork";
	if (blockedByReview(host, forking ? "forking" : "/session")) return;
	// 一轮进行中不能换会话：宿主会关掉旧会话的写入器，正在跑的驱动下一次追加就失败，
	// 而新会话已经把旧 turn 移出了界面状态——本轮回复会无声地丢掉。
	if (host.state.activeTurn !== undefined) {
		host.resetStatusMeta();
		host.setStatus(waitForTurn(forking ? "Forking" : "/session"), "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	let result: SessionSwitchResult;
	try {
		const run = forking ? source.fork : source.select;
		if (run === undefined) throw new Error("Forking isn't available");
		result = run(id);
	} catch (error) {
		host.state.follow = true;
		const message = describeError(error);
		host.appendCommandTurn("/session", [
			{
				kind: "error",
				text: failure(forking ? FAILURE_ACTIONS.sessionFork : FAILURE_ACTIONS.sessionSwitch, message),
			},
		]);
		return;
	}
	if (!result.changed) {
		host.render();
		return;
	}

	applyConversation(host, result);
	if (forking) {
		const origin = result.fork?.sourceId ?? id;
		const copied = result.fork?.copied ?? 0;
		host.appendCommandTurn("/session", [
			forkedSession(origin, copied),
			FORK_WORKSPACE_NOTE,
			...result.warnings,
		]);
		return;
	}
	host.appendCommandTurn("/session", [switchedSession(id), ...result.warnings]);
}
