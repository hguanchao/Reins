import { THINKING_LEVELS } from "../../config/config-file.ts";
import { describeError } from "../../describe-error.ts";
import type { CommandMenuItem } from "../panel/command-menu.ts";
import type { SessionMenuItem } from "../panel/session-menu.ts";
import type { SessionSwitchResult } from "../options.ts";
import { CONFIGURATION_REQUIRED, SESSION_UNAVAILABLE, implementationPrompt } from "../status.ts";
import { markTranscriptDirty } from "./transcript-state.ts";
import { closePlanReview, openPlanReview, showPage } from "./pages.ts";
import {
	openEffortMenu,
	openModelMenu,
	openSessionMenu,
	selectEffort,
	selectModel,
} from "./panels.ts";
import { startRun } from "./run.ts";
import type { TuiHost } from "./types.ts";

/**
 * 斜杠命令的执行。
 *
 * 每条命令一个处理器；分派表只按名字查表，新增命令加一个条目即可。命令回复作为
 * 一条对话记录追加，不进入模型回合。
 */

export function executeCommand(host: TuiHost, command: CommandMenuItem, args = ""): void {
	const state = host.state;
	state.commandMenu = undefined;
	// 从补全面板执行时把输入补全成完整命令，面板打开期间看得清当前在做什么
	host.setInput(`/${command.name}`);

	const handlers: Readonly<Record<string, () => void>> = {
		model: () => executeModelCommand(host, args),
		effort: () => executeEffortCommand(host, args),
		session: () => executeSessionCommand(host, args),
		fork: () => executeForkCommand(host),
		compact: () => executeCompactCommand(host),
		plan: () => executePlanCommand(host, args),
		"view-plan": () => executeViewPlanCommand(host),
		undo: () => executeUndoCommand(host),
		checkpoints: () => executeCheckpointsCommand(host),
		sandbox: () => {
			if (host.options.sandbox !== undefined) showPage(state, "sandbox");
		},
		jobs: () => executeJobsCommand(host),
		help: () => showPage(state, "help"),
		skills: () => showPage(state, "skills"),
		mcps: () => showPage(state, "mcps"),
	};
	const handler = handlers[command.name];
	if (handler !== undefined) {
		// 整屏页期间输入框不接受按键，命令名一律不留在输入框里
		if (
			command.name === "help" ||
			command.name === "skills" ||
			command.name === "mcps" ||
			command.name === "sandbox"
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
		host.setStatus("Plugin commands are unavailable in Plan mode", "notice");
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
	const turn = { prompt: `/${command.name}`, response: [] as import("../transcript.ts").TranscriptLine[] };
	state.turns.push(turn);
	markTranscriptDirty(state);
	state.hasInput = true;
	state.follow = true;
	host.resetStatusMeta();
	if (state.statusClearTimer !== undefined) {
		clearTimeout(state.statusClearTimer);
		state.statusClearTimer = undefined;
	}
	host.setStatus(`Running /${command.name}...`);
	host.render();

	void source
		.run(command.name, args)
		.then((lines) => {
			if (state.finished) return;
			turn.response.push(...lines);
			markTranscriptDirty(state);
			host.clearStatus();
			host.render();
			host.notify(`/${command.name} finished`);
		})
		.catch((error) => {
			if (state.finished) return;
			turn.response.push({
				text: `Error: ${describeError(error)}`,
				kind: "error",
			});
			markTranscriptDirty(state);
			host.setStatus("Error", "error");
			host.render();
			host.notify(`/${command.name} failed`);
		});
}

/** /model:无参数开面板,带参数直接选中那个模型。 */
function executeModelCommand(host: TuiHost, args: string): void {
	const source = host.options.modelMenu;
	if (source === undefined) {
		host.setInput("");
		host.resetStatusMeta();
		host.setStatus(CONFIGURATION_REQUIRED, "notice");
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
				? "No models are available."
				: {
						kind: "error",
						text: `Error: Unknown model: ${target}. Run /model to choose from the list.`,
					},
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
		host.setStatus(CONFIGURATION_REQUIRED, "notice");
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
				text: `Error: Unknown effort: ${target}. Available: ${THINKING_LEVELS.join(", ")}.`,
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
		host.setStatus(SESSION_UNAVAILABLE, "notice");
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

/** /fork:从当前会话的当前末尾分叉，并切换到新会话。 */
function executeForkCommand(host: TuiHost): void {
	const source = host.options.sessionMenu;
	host.setInput("");
	if (source === undefined || source.fork === undefined) {
		host.resetStatusMeta();
		host.setStatus("Session forking is unavailable in this session", "notice");
		return;
	}

	host.state.follow = true;
	let items: readonly SessionMenuItem[];
	try {
		items = source.list();
	} catch (error) {
		host.appendCommandTurn("/fork", [{ kind: "error", text: `Error: Failed to list sessions: ${describeError(error)}` }]);
		return;
	}
	const current = items.find((item) => item.current);
	if (current === undefined) {
		host.appendCommandTurn("/fork", [
			{ kind: "error", text: "Error: The current session is not in the session list." },
		]);
		return;
	}
	host.switchSession(current.id, "fork");
}

/** /compact:立即压缩一轮上下文。 */
function executeCompactCommand(host: TuiHost): void {
	const compact = host.options.agent?.compact;
	host.setInput("");
	if (compact === undefined) {
		host.resetStatusMeta();
		host.setStatus(CONFIGURATION_REQUIRED, "notice");
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
		host.setStatus("Plan mode is unavailable in this session", "notice");
		return;
	}
	if (host.state.activeTurn !== undefined) {
		host.resetStatusMeta();
		host.setStatus("/plan is unavailable while a turn is running", "notice");
		return;
	}

	const task = args.trim();
	const enabled = task.length > 0 || !source.current();
	try {
		if (source.current() !== enabled) source.select(enabled);
	} catch (error) {
		host.resetStatusMeta();
		host.setStatus(`Failed to switch Plan mode: ${describeError(error)}`, "error");
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

/** /view-plan:重新打开最近一份计划；没有计划时只给提示。 */
function executeViewPlanCommand(host: TuiHost): void {
	host.setInput("");
	const plan = host.state.latestPlan;
	if (plan === undefined) {
		host.resetStatusMeta();
		host.setStatus("No plan yet. Use /plan to write one.", "notice");
		host.scheduleStatusClear();
		return;
	}
	openPlanReview(host, plan);
}

function executeUndoCommand(host: TuiHost): void {
	host.setInput("");
	host.runUndo();
}

function executeCheckpointsCommand(host: TuiHost): void {
	host.setInput("");
	host.openCheckpointList();
}

function executeJobsCommand(host: TuiHost): void {
	host.setInput("");
	host.openJobsPage();
}

/** 批准计划：退出 Plan 模式，并把整份计划作为新提示交给模型。 */
export function approvePlan(host: TuiHost): void {
	const plan = host.state.planReview ?? host.state.latestPlan;
	if (plan === undefined) {
		closePlanReview(host.state);
		host.render();
		return;
	}

	const agent = host.options.agent;
	closePlanReview(host.state);
	if (agent === undefined) {
		host.resetStatusMeta();
		host.setStatus("Agent unavailable", "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	try {
		if (host.planning()) host.options.planMode?.select(false);
	} catch (error) {
		host.resetStatusMeta();
		host.setStatus(`Failed to leave Plan mode: ${describeError(error)}`, "error");
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
	if (!host.planning()) {
		if (host.options.planMode === undefined) {
			host.resetStatusMeta();
			host.setStatus("Plan mode is unavailable in this session", "notice");
			host.scheduleStatusClear();
			host.render();
			return;
		}
		try {
			host.options.planMode.select(true);
		} catch (error) {
			host.resetStatusMeta();
			host.setStatus(`Failed to enter Plan mode: ${describeError(error)}`, "error");
			host.scheduleStatusClear();
			host.render();
			return;
		}
	}

	if (host.state.input.length === 0) host.setInput("Revise the plan: ");
	host.clearStatus();
	host.render();
}

/** 退出计划：关闭审批页并离开 Plan 模式，计划本身仍可用 /view-plan 回看。 */
export function leavePlan(host: TuiHost): void {
	const wasPlanning = host.planning();
	closePlanReview(host.state);
	try {
		if (wasPlanning) host.options.planMode?.select(false);
	} catch (error) {
		host.resetStatusMeta();
		host.setStatus(`Failed to leave Plan mode: ${describeError(error)}`, "error");
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
	let result: SessionSwitchResult;
	try {
		const run = forking ? source.fork : source.select;
		if (run === undefined) throw new Error("Session forking is unavailable");
		result = run(id);
	} catch (error) {
		host.state.follow = true;
		const message = describeError(error);
		host.appendCommandTurn(forking ? "/fork" : "/session", [
			{
				kind: "error",
				text: `Error: Failed to ${forking ? "fork" : "switch"} session: ${message}`,
			},
		]);
		return;
	}
	if (!result.changed) {
		host.render();
		return;
	}

	const state = host.state;
	state.turns.length = 0;
	for (const turn of result.history) {
		state.turns.push({ prompt: turn.prompt, response: [...turn.response] });
	}
	// 任务表与计划都属于会话:随历史一起换成新会话的内容
	state.currentTodo = result.todo;
	state.latestPlan = result.plan;
	state.pendingPlan = undefined;
	if (state.openPage === "plan") closePlanReview(state);
	else state.planReview = undefined;
	host.closeCheckpointPage();
	markTranscriptDirty(state);
	state.initialScroll = false;
	state.scrollTop = 0;
	state.follow = true;
	state.hasInput = state.turns.length > 0;
	// 上一个会话留下的状态/错误不该跟着出现在新会话里
	host.clearStatus();
	// 排队消息是发给旧会话的，换会话后没有意义
	state.queued.length = 0;
	state.fileMenu = undefined;
	state.fileFiles = undefined;
	state.fileIndexStart = undefined;
	host.clearAttachments();
	if (forking) {
		const origin = result.fork?.sourceId ?? id;
		const copied = result.fork?.copied ?? 0;
		host.appendCommandTurn("/fork", [
			`Forked from ${origin} · ${copied} ${copied === 1 ? "entry" : "entries"} copied`,
			"Workspace unchanged · checkpoints start fresh within the fork.",
			...result.warnings,
		]);
		return;
	}
	host.appendCommandTurn("/session", [`Switched to session ${id}.`, ...result.warnings]);
}
