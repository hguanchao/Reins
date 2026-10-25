import type { AgentEventListener } from "../agent/events.ts";
import {
	CURSOR_BLINKING_BAR,
	ENABLE_BRACKETED_PASTE,
	ENABLE_FOCUS_REPORTING,
	ENABLE_MOUSE,
	ENTER_ALTERNATE_SCREEN,
	HIDE_CURSOR,
} from "./terminal.ts";
import { mergeCommands } from "./commands.ts";
import type { TuiOptions } from "./options.ts";
import { createState } from "./runtime/state.ts";
import { createInputHandler } from "./runtime/input.ts";
import { render } from "./runtime/render.ts";
import { onCtrlC } from "./runtime/ctrl-c.ts";
import { cleanup } from "./runtime/lifecycle.ts";
import { startRun } from "./runtime/run.ts";
import { notify } from "./runtime/run.ts";
import { drainQueue } from "./runtime/run.ts";
import {
	compactFooter,
	footerHeight,
	inputTopRow,
	jobBarHeight,
	mainAreaHeight,
	menuOpen,
	modalMenuOpen,
	planning,
	terminalRows,
	terminalWidth,
	todoPanelHeight,
} from "./runtime/geometry.ts";
import { currentTranscript, markTranscriptDirty } from "./runtime/transcript-state.ts";
import { noticeText } from "./runtime/notice.ts";
import {
	approvalPanelTop,
	moveApprovalSelection,
	resolveApproval,
	syncApprovalPrompt,
} from "./runtime/approval.ts";
import { closePlanReview, openPlanReview, pageLines } from "./runtime/pages.ts";
import { setStatus, clearStatus, resetStatusMeta, scheduleStatusClear } from "./runtime/status.ts";
import { closeThinking, appendLine, syncTurn, syncTurnFull } from "./runtime/turn.ts";
import {
	appendJobNote,
	closeJobPage,
	ensureJobVisible,
	ensureJobTimer,
	killSelectedJob,
	openJobDetail,
	openJobsPage,
	selectedJob,
} from "./runtime/jobs.ts";
import {
	closeCheckpointPage,
	ensureCheckpointVisible,
	executeUndo,
	loadCheckpointPreview,
	openCheckpointList,
	restoreCheckpoint,
} from "./runtime/checkpoints.ts";
import {
	attachClipboardImage,
	attachImagePath,
	clearAttachments,
	draggedImagePath,
	imagesOf,
	insertImageMarker,
	readAndInsertImage,
} from "./runtime/attachments.ts";
import { recallHistory, rememberInput } from "./runtime/history.ts";
import {
	approvePlan,
	executeCommand,
	leavePlan,
	revisePlan,
	switchSession,
} from "./runtime/commands.ts";
import {
	cancelEffortMenu,
	cancelMenu,
	cancelSessionMenu,
	closeFileMenu,
	completeEffortMenu,
	completeModelMenu,
	completeSessionMenu,
	confirmEffortMenu,
	confirmMenu,
	confirmSessionMenu,
	forkSelectedSession,
	insertFileReference,
	moveCommandMenu,
	moveEffortMenu,
	moveFileMenu,
	moveMenu,
	moveSessionMenu,
	openEffortMenu,
	openModelMenu,
	openSessionMenu,
	updateCommandMenu,
	updateFileMenu,
} from "./runtime/panels.ts";
import { submit } from "./runtime/submit.ts";
import { togglingTranscriptAt } from "./runtime/view.ts";
import type { ActiveTurn, TuiHost } from "./runtime/types.ts";
import type { ImageAttachment } from "../image/attachment.ts";
import { measureTranscriptView, scrollTopForRow as scrollTopForRowImpl, type TranscriptMetrics } from "./transcript.ts";
import type { TranscriptLine } from "./transcript.ts";

/**
 * 全屏界面入口。
 *
 * 只做装配：建状态、把各域模块绑成一份 host 契约、挂终端事件。各域实现分别在 runtime
 * 下的独立文件里，互相不直接调用，需要协作时经过 host。
 */
export async function runTui(options: TuiOptions): Promise<number> {
	const state = createState(options);
	/** 初始化时先占位，装配完成后再指向真正实现。 */
	let onData: (chunk: Buffer) => void = () => {};
	let cleanUp: () => void = () => {};

	const host: TuiHost = {
		options,
		state,
		render: () => render(host),
		setInput: (value, cursor = value.length) => {
			state.input = value;
			state.inputCursor = Math.min(Math.max(0, cursor), value.length);
		},
		setStatus: (text, tone) => setStatus(state, text, tone),
		clearStatus: () => clearStatus(state),
		resetStatusMeta: () => resetStatusMeta(state),
		scheduleStatusClear: () => scheduleStatusClear(state, host.render),
		markTranscriptDirty: () => markTranscriptDirty(state),
		showPage: (kind) => {
			state.openPage = kind;
			state.pageScrollTop = 0;
			state.pageCache = undefined;
		},
		pageLines: (kind, width) => pageLines(host, kind, width),
		terminalWidth: () => terminalWidth(state),
		terminalHeight: () => terminalRows(state),
		mainAreaHeight: () => mainAreaHeight(state, options),
		footerHeight: () => footerHeight(state, options),
		todoPanelHeight: () => todoPanelHeight(state, options),
		jobBarHeight: () => jobBarHeight(state, options),
		approvalPanelTop: () => approvalPanelTop(state, options),
		inputTopRow: (mainHeight) => inputTopRow(state, options, mainHeight),
		commands: () => mergeCommands(state.builtinCommands, options.pluginCommands?.list() ?? []),
		noticeText: () => noticeText(state),
		currentTranscript: (width) => currentTranscript(state, width),
		maxScroll: () => maxScroll(host),
		planning: () => planning(options),
		menuOpen: () => menuOpen(state),
		modalMenuOpen: () => modalMenuOpen(state),
		compactFooter: () => compactFooter(state),
		scrollTopForRow: (row, limit) => scrollTopForRow(host, row, limit),
		startRun: (prompt, images, run) => startRun(host, prompt, images, run),
		launch: (prompt, images = []) => launch(host, prompt, images),
		drainQueue: () => drainQueue(host),
		appendLine: (active, line) => appendLine(host, active, line),
		syncTurn: (active) => syncTurn(host, active),
		syncTurnFull: (active) => syncTurnFull(host, active),
		closeThinking: (active) => closeThinking(host, active),
		appendCommandTurn: (prompt, response) => appendCommandTurn(host, prompt, response),
		openPlanReview: (plan) => openPlanReview(host, plan),
		closePlanReview: () => closePlanReview(state),
		closeCheckpointPage: () => closeCheckpointPage(host),
		closeJobPage: () => closeJobPage(host),
		clearAttachments: () => clearAttachments(host),
		syncApprovalPrompt: () => syncApprovalPrompt(host),
		resolveApproval: (answer) => resolveApproval(host, answer),
		moveApprovalSelection: (delta) => moveApprovalSelection(host, delta),
		notify: (message) => notify(host, message),
		runUndo: () => executeUndo(host),
		toggleTranscriptAt: (row, column, mainHeight, width) =>
			togglingTranscriptAt(host, row, column, mainHeight, width),
		switchSession: (id, action) => switchSession(host, id, action),
		sessionTitle: (title) => sessionTitle(title),
		jobsOf: () => options.jobs?.list() ?? [],
		selectedJob: () => selectedJob(host),
		ensureCheckpointVisible: () => ensureCheckpointVisible(host),
		ensureJobVisible: () => ensureJobVisible(host),
		openJobDetail: (job) => openJobDetail(host, job),
		killSelectedJob: () => killSelectedJob(host),
		openJobsPage: () => openJobsPage(host),
		openCheckpointList: () => openCheckpointList(host),
		restoreCheckpoint: () => restoreCheckpoint(host),
		loadCheckpointPreview: (entry) => loadCheckpointPreview(host, entry),
		applySession: () => {},
		rememberInput: (value) => rememberInput(state, value),
		recallHistory: (delta) => recallHistory(state, delta, () => {
			host.updateCommandMenu();
			host.updateFileMenu();
			host.render();
		}),
		insertImageMarker: (image, at) => insertImageMarker(host, image, at),
		attachImagePath: (path, at) => attachImagePath(host, path, at),
		attachClipboardImage: (at) => attachClipboardImage(host, at),
		readAndInsertImage: (read, status, at) => readAndInsertImage(host, read, status, at),
		draggedImagePath: (chunk) => draggedImagePath(host, chunk),
		imagesInInput: () => imagesOf(state),
		approvePlan: () => approvePlan(host),
		revisePlan: () => revisePlan(host),
		leavePlan: () => leavePlan(host),
		executeUndo: () => executeUndo(host),
		startJobTimer: () => ensureJobTimer(host),
		closeFileMenu: (dismissed) => closeFileMenu(host, dismissed),
		updateCommandMenu: () => updateCommandMenu(host),
		updateFileMenu: () => updateFileMenu(host),
		insertFileReference: () => insertFileReference(host, (path, at) => attachImagePath(host, path, at)),
		openModelMenu: () => openModelMenu(host),
		moveMenu: (delta) => moveMenu(host, delta),
		confirmMenu: () => confirmMenu(host),
		completeModelMenu: () => completeModelMenu(host),
		cancelMenu: () => cancelMenu(host),
		openEffortMenu: () => openEffortMenu(host),
		moveEffortMenu: (delta) => moveEffortMenu(host, delta),
		confirmEffortMenu: () => confirmEffortMenu(host),
		completeEffortMenu: () => completeEffortMenu(host),
		cancelEffortMenu: () => cancelEffortMenu(host),
		openSessionMenu: () => openSessionMenu(host),
		moveSessionMenu: (delta) => moveSessionMenu(host, delta),
		confirmSessionMenu: () => confirmSessionMenu(host),
		completeSessionMenu: () => completeSessionMenu(host),
		cancelSessionMenu: () => cancelSessionMenu(host),
		forkSelectedSession: () => forkSelectedSession(host),
		moveCommandMenu: (delta) => moveCommandMenu(host, delta),
		moveFileMenu: (delta) => moveFileMenu(host, delta),
		executeCommand: (command, args) => executeCommand(host, command, args),
		submit: () => submit(host),
	};

	onData = createInputHandler(host, {
		render: host.render,
		onCtrlC: () => onCtrlC(host, { render: host.render, cleanup: cleanUp }),
	});
	cleanUp = () =>
		cleanup(state, options, { render: host.render, onData, onInterrupt: cleanUp });

	state.unsubscribeJobs =
		options.jobs?.subscribe((event) => {
			if (event.type === "finished") appendJobNote(host, event.job);
			ensureJobTimer(host);
			host.render();
		}) ?? (() => {});
	ensureJobTimer(host);

	const done = new Promise<number>((resolve) => {
		state.finish = () => resolve(0);
	});

	try {
		state.stdout.write(
			ENTER_ALTERNATE_SCREEN +
				CURSOR_BLINKING_BAR +
				HIDE_CURSOR +
				ENABLE_FOCUS_REPORTING +
				ENABLE_MOUSE +
				ENABLE_BRACKETED_PASTE,
		);
		state.stdin.setRawMode?.(true);
		state.stdin.resume();
		state.stdout.on("resize", host.render);
		state.stdin.on("data", onData);
		process.on("SIGINT", cleanUp);
		host.render();
	} catch (error) {
		cleanUp();
		throw error;
	}

	return done;
}

/** 主区域可见范围内的最大滚动量。 */
function maxScroll(host: TuiHost): number {
	const width = host.terminalWidth();
	const mainHeight = host.mainAreaHeight();
	const metrics = measure(host, width, mainHeight);
	return Math.max(0, metrics.scrollLines - mainHeight);
}

function measure(host: TuiHost, width: number, mainHeight: number): TranscriptMetrics {
	return measureTranscriptView(host.currentTranscript(width), mainHeight);
}

/** 滚动条拖动到的行换算成滚动量。 */
function scrollTopForRow(host: TuiHost, row: number, limit: number): number {
	return scrollTopForRowImpl(row, host.mainAreaHeight(), limit);
}

/** 普通提问交给真实对话；没有 agent 时只更新状态行。 */
function launch(host: TuiHost, prompt: string, images: readonly ImageAttachment[]): void {
	const agent = host.options.agent;
	if (agent === undefined) {
		host.state.commandMenu = undefined;
		host.resetStatusMeta();
		host.setStatus("Agent unavailable", "notice");
		host.render();
		return;
	}
	startRun(host, prompt, images, (onEvent, signal) => agent.runTurn(prompt, images, onEvent, signal));
}

/**
 * 把一条命令的回复放进对话流。
 *
 * 一轮进行中时先排队，等这一轮结束再追加：对话流会跟着最后一条提示贴底，插在流中间
 * 无论排前还是排后都会被顶走。页脚已经即时反映了新模型，这里是留给回看的记录。
 */
function appendCommandTurn(host: TuiHost, prompt: string, response: readonly TranscriptLine[]): void {
	const state = host.state;
	const block = { prompt, response: [...response] };
	markTranscriptDirty(state);
	state.hasInput = true;
	if (state.activeTurn !== undefined) {
		state.pendingCommandTurns.push(block);
		return;
	}
	state.turns.push(block);
	host.render();
}

/** 会话菜单里的一行标题：控制字符会弄乱面板，统一换成空格。 */
function sessionTitle(title: string | undefined): string {
	const text = (title ?? "").replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return text.length === 0 ? "(no conversation yet)" : text;
}

export type { ActiveTurn, AgentEventListener, ImageAttachment, TranscriptLine };
