import { CHECKPOINT_ACTION_HEIGHT } from "../page/checkpoint.ts";
import { MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, menuKey, scrollKey } from "./keys.ts";
import type { MouseInput } from "./keys.ts";
import { JOB_ACTION_HEIGHT } from "../page/job.ts";
import { PLAN_ACTION_HEIGHT } from "../page/plan.ts";
import { SANDBOX_ACTION_HEIGHT } from "../page/sandbox.ts";
import type { InputDeps } from "./dispatch.ts";
import type { TuiHost } from "../runtime/types.ts";

export function handlePageInput(
	host: TuiHost,
	deps: InputDeps,
	text: string,
	mouseOf: () => readonly MouseInput[],
): void {
	const state = host.state;
	const page = state.openPage;
	if (page === undefined) return;
	const key = menuKey(text);
	// 计划审批页先处理自己的三个动作，其余按键仍走通用的翻页规则
	if (page === "plan") {
		if (text === "a") return host.approvePlan();
		if (text === "r") return host.revisePlan();
		if (text === "q") return host.leavePlan();
	}
	if (page === "checkpoints") {
		if (key === "up" || key === "down") {
			if (state.checkpointList.length > 0) {
				state.checkpointCursor = Math.min(
					state.checkpointList.length - 1,
					Math.max(0, state.checkpointCursor + (key === "up" ? -1 : 1)),
				);
				host.ensureCheckpointVisible();
				deps.render();
			}
			return;
		}
		if (key === "enter") {
			const entry = state.checkpointList[state.checkpointCursor];
			if (entry !== undefined) host.loadCheckpointPreview(entry);
			return;
		}
		if (key === "escape") {
			host.closeCheckpointPage();
			deps.render();
			return;
		}
	}
	if (page === "checkpoint") {
		if (text === "u") return host.restoreCheckpoint();
		if (key === "escape") {
			if (state.checkpointReturnToList) {
				state.openPage = "checkpoints";
				state.checkpointPreview = undefined;
				state.pageScrollTop = 0;
				host.ensureCheckpointVisible();
				deps.render();
			} else {
				host.closeCheckpointPage();
				deps.render();
			}
			return;
		}
	}
	if (page === "jobs") {
		if (key === "up" || key === "down") {
			const jobs = host.options.jobs?.list() ?? [];
			if (jobs.length > 0) {
				state.jobCursor = Math.min(
					jobs.length - 1,
					Math.max(0, state.jobCursor + (key === "up" ? -1 : 1)),
				);
				host.ensureJobVisible();
				deps.render();
			}
			return;
		}
		if (key === "enter") {
			const job = host.selectedJob();
			if (job !== undefined) host.openJobDetail(job);
			return;
		}
		if (text === "k") return host.killSelectedJob();
		if (key === "escape") {
			host.closeJobPage();
			deps.render();
			return;
		}
	}
	if (page === "job") {
		if (text === "k") {
			const job = host.options.jobs?.list().find((candidate) => candidate.id === state.jobDetailId);
			if (job !== undefined) {
				host.options.jobs?.kill(job.id);
				deps.render();
			}
			return;
		}
		if (key === "escape") {
			if (state.jobReturnToList) {
				state.openPage = "jobs";
				state.jobDetailId = undefined;
				state.pageScrollTop = 0;
				host.ensureJobVisible();
				deps.render();
			} else {
				host.closeJobPage();
				deps.render();
			}
			return;
		}
	}
	// 整屏页是模态的：上下键与滚轮翻页，Esc 返回，其它按键忽略
	const actionHeight =
		page === "plan"
			? PLAN_ACTION_HEIGHT
			: page === "checkpoints" || page === "checkpoint"
				? CHECKPOINT_ACTION_HEIGHT
				: page === "jobs" || page === "job"
					? JOB_ACTION_HEIGHT
					: page === "sandbox"
						? SANDBOX_ACTION_HEIGHT
						: 0;
	const rows = Math.max(1, host.mainAreaHeight() - actionHeight);
	const width = host.terminalWidth();
	const total = host.pageLines(page, width).length;
	let steps = 0;
	for (const event of mouseOf()) {
		if (event.press && event.button === MOUSE_WHEEL_UP) steps -= 1;
		else if (event.press && event.button === MOUSE_WHEEL_DOWN) steps += 1;
	}
	if (key === "up") steps -= 1;
	if (key === "down") steps += 1;
	const scroll = scrollKey(text);
	if (scroll === "pageUp") steps -= rows;
	if (scroll === "pageDown") steps += rows;

	if (key === "escape") {
		if (page === "plan") host.closePlanReview();
		else state.openPage = undefined;
		deps.render();
		return;
	}
	if (scroll === "top") {
		state.pageScrollTop = 0;
		deps.render();
		return;
	}
	if (steps !== 0) {
		state.pageScrollTop = Math.min(Math.max(0, state.pageScrollTop + steps), Math.max(0, total - rows));
		deps.render();
	}
}

/** 对话流与输入框：点击、滚动、补全面板按键与文本编辑。 */
