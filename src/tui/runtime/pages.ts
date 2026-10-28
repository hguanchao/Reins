import {
	mcpsActionLines,
	mcpsPageLines,
	skillsPageLines,
	helpPageLines,
	framedPage,
	renderPage,
} from "../page/frame.ts";
import { planActionLines, planReviewLines } from "../page/plan.ts";
import { viewerActionLines, viewerPageLines } from "../page/viewer.ts";
import type { PageKind } from "../options.ts";
import type { TranscriptPlan } from "../transcript.ts";
import type { TuiHost, TuiState } from "./types.ts";

/**
 * 整屏页。
 *
 * 页面内容按宽度排版并缓存；带动作条的页面把动作条钉在底部，正文按剩余高度滚动。
 * 计划与 MCP 页共用同一套几何，动作条变化时不会各自偏移。
 */

/** 打开一整页：滚动位置回到顶部，下次绘制按当前宽度重排。 */
export function showPage(state: TuiState, kind: PageKind): void {
	state.openPage = kind;
	state.pageScrollTop = 0;
	state.pageCache = undefined;
	// 整屏页里没有对话流选区；留着只会在返回时闪出一块旧高亮
	state.selection = undefined;
}

/** 页面内容；宽度变了才重排，滚动与重绘都复用同一份。 */
export function pageLines(host: TuiHost, kind: PageKind, width: number): readonly string[] {
	// MCP 页有光标与实时连接状态：不缓存，避免画出上一帧
	if (kind === "mcps") {
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
		return skillsPageLines(width, source.list(), source.directories());
	}
	if (kind === "plan") {
		return state.planReview === undefined ? [] : planReviewLines(state.planReview, width);
	}
	if (kind === "viewer") {
		return state.viewer === undefined ? [] : viewerPageLines(state.viewer, width);
	}
	if (kind === "mcps") {
		const servers = host.options.mcpServers?.() ?? [];
		state.mcpCursor = Math.min(state.mcpCursor, Math.max(0, servers.length - 1));
		return mcpsPageLines(width, servers, state.mcpCursor);
	}
	return [];
}

/** 打开计划审批页；计划同时成为最近一份，供计划卡重新打开。 */
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

/** 关闭审批页但保留最近一份计划，之后仍可由计划卡打开。 */
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
	if (kind === "mcps") return framedPage(content, mcpsActionLines(width), height, scroll);
	if (kind === "viewer") return framedPage(content, viewerActionLines(width), height, scroll);
	return renderPage(content, height, scroll);
}
