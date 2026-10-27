import type { CheckpointEntry } from "../../checkpoint/service.ts";
import {
	mcpsPageLines,
	skillsPageLines,
	helpPageLines,
	framedPage,
	renderPage,
} from "../page/frame.ts";
import {
	checkpointListActions,
	checkpointListLines,
	checkpointPreviewActions,
	checkpointPreviewLines,
} from "../page/checkpoint.ts";
import { jobListActions, jobListLines, jobOutputActions, jobOutputLines } from "../page/job.ts";
import { planActionLines, planReviewLines } from "../page/plan.ts";
import { sandboxActionLines, sandboxPageLines } from "../page/sandbox.ts";
import { viewerActionLines, viewerPageLines } from "../page/viewer.ts";
import { THEME } from "../render/theme.ts";
import { RESET } from "../panel/menu-panel.ts";
import type { PageKind } from "../options.ts";
import type { TranscriptPlan } from "../transcript.ts";
import type { TuiHost, TuiState } from "./types.ts";

/**
 * 整屏页。
 *
 * 页面内容按宽度排版并缓存；带动作条的页面把动作条钉在底部，正文按剩余高度滚动。
 * 计划、检查点、作业与沙箱页共用同一套几何，动作条变化时不会各自偏移。
 */

/** 打开一整页：滚动位置回到顶部，下次绘制按当前宽度重排。 */
export function showPage(state: TuiState, kind: PageKind): void {
	state.openPage = kind;
	state.pageScrollTop = 0;
	state.pageCache = undefined;
}

/** 页面内容；宽度变了才重排，滚动与重绘都复用同一份。 */
export function pageLines(host: TuiHost, kind: PageKind, width: number): readonly string[] {
	// 检查点与作业都有光标/实时状态：不缓存，避免画出上一帧
	if (kind === "checkpoints" || kind === "checkpoint" || kind === "jobs" || kind === "job") {
		return buildPage(host, kind, width);
	}
	const cache = host.state.pageCache;
	if (cache?.kind === kind && cache.width === width) return cache.lines;
	const lines = buildPage(host, kind, width);
	host.state.pageCache = { kind, width, lines };
	return lines;
}

function buildPage(host: TuiHost, kind: PageKind, width: number): readonly string[] {
	const state = host.state;
	if (kind === "help") return helpPageLines(width, host.commands());
	if (kind === "skills") {
		const source = host.options.skills;
		if (source === undefined) return skillsPageLines(width, [], []);
		return skillsPageLines(width, source.list(), source.directories);
	}
	if (kind === "sandbox") {
		const source = host.options.sandbox;
		return source === undefined ? [] : sandboxPageLines(source.info, width);
	}
	if (kind === "plan") {
		return state.planReview === undefined ? [] : planReviewLines(state.planReview, width);
	}
	if (kind === "checkpoints") {
		return checkpointListLines(state.checkpointList, width, state.checkpointCursor, state.checkpointLoading);
	}
	if (kind === "checkpoint") {
		return state.checkpointPreview === undefined
			? checkpointListLines([], width, 0)
			: checkpointPreviewLines(state.checkpointPreview, width);
	}
	if (kind === "jobs") {
		const jobs = host.options.jobs?.list() ?? [];
		state.jobCursor = Math.min(state.jobCursor, Math.max(0, jobs.length - 1));
		return jobListLines(jobs, width, state.jobCursor);
	}
	if (kind === "job") {
		const job = host.options.jobs?.list().find((candidate) => candidate.id === state.jobDetailId);
		if (job === undefined) {
			return [
				`${THEME.accent}Reins — jobs${RESET}`,
				"",
				`${THEME.textSubtle}  This job is no longer available.${RESET}`,
			];
		}
		return jobOutputLines(job, host.options.jobs?.output(job.id) ?? "", width);
	}
	if (kind === "viewer") {
		return state.viewer === undefined ? [] : viewerPageLines(state.viewer, width);
	}
	return mcpsPageLines(width, host.options.mcpServers?.() ?? []);
}

/** 打开计划审批页；计划同时成为 /view-plan 的最近一份。 */
export function openPlanReview(host: TuiHost, plan: TranscriptPlan): void {
	const state = host.state;
	state.planReview = plan;
	state.latestPlan = plan;
	// 审批页是整屏模态：自动打开时先收掉可能在回合期间留下的菜单
	state.commandMenu = undefined;
	state.modelMenu = undefined;
	state.effortMenu = undefined;
	state.sessionMenu = undefined;
	showPage(state, "plan");
}

/** 关闭审批页但保留最近一份计划，之后仍可用 /view-plan 打开。 */
export function closePlanReview(state: TuiState): void {
	if (state.openPage === "plan") state.openPage = undefined;
	state.planReview = undefined;
	state.pageScrollTop = 0;
}

/** 按页面类型给整屏内容加动作条。 */
export function framedPageFor(
	host: TuiHost,
	kind: PageKind,
	width: number,
	height: number,
): readonly string[] {
	const state = host.state;
	const content = pageLines(host, kind, width);
	const scroll = state.pageScrollTop;
	if (kind === "plan") return framedPage(content, planActionLines(width), height, scroll);
	if (kind === "checkpoint") {
		const actions = checkpointPreviewActions(width, state.checkpointPreview?.entry.kind ?? "turn");
		return framedPage(content, actions, height, scroll);
	}
	if (kind === "checkpoints") return framedPage(content, checkpointListActions(width), height, scroll);
	if (kind === "job") {
		const selected = host.options.jobs?.list().find((job) => job.id === state.jobDetailId);
		return framedPage(content, jobOutputActions(width, selected?.status ?? "done"), height, scroll);
	}
	if (kind === "jobs") return framedPage(content, jobListActions(width), height, scroll);
	if (kind === "sandbox") return framedPage(content, sandboxActionLines(width), height, scroll);
	if (kind === "viewer") return framedPage(content, viewerActionLines(width), height, scroll);
	return renderPage(content, height, scroll);
}


export type { CheckpointEntry };

/**
 * 让列表页的光标始终落在可见区内。
 *
 * `row` 是光标在页面正文里的行号，`rows` 是可滚动区域的高度（已扣掉动作条）。上下越界时
 * 只挪到刚好可见，滚动位置不会跳动。
 */
export function ensureCursorVisible(state: TuiState, row: number, rows: number): void {
	if (row < state.pageScrollTop) state.pageScrollTop = row;
	else if (row >= state.pageScrollTop + rows) state.pageScrollTop = row - rows + 1;
}
