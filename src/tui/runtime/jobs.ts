import { JOB_ACTION_HEIGHT } from "../job-pages.ts";
import { jobElapsed } from "../job-pages.ts";
import type { JobView } from "../job-pages.ts";
import { showPage } from "./pages.ts";
import type { TuiHost } from "./types.ts";

/** 后台作业页与作业说明。 */

/** 打开作业列表；没有作业源时只给提示。 */
export function openJobsPage(host: TuiHost): void {
	if (host.options.jobs === undefined) {
		host.resetStatusMeta();
		host.setStatus("Background jobs are unavailable in this session", "notice");
		host.scheduleStatusClear();
		return;
	}
	const state = host.state;
	state.jobCursor = 0;
	state.jobDetailId = undefined;
	state.jobReturnToList = false;
	showPage(state, "jobs");
}

/** 关闭作业列表/输出页。 */
export function closeJobPage(host: TuiHost): void {
	const state = host.state;
	if (state.openPage === "jobs" || state.openPage === "job") state.openPage = undefined;
	state.jobDetailId = undefined;
	state.jobCursor = 0;
	state.jobReturnToList = false;
	state.pageScrollTop = 0;
}

export function selectedJob(host: TuiHost): JobView | undefined {
	const jobs = host.options.jobs?.list() ?? [];
	if (jobs.length === 0) return undefined;
	const state = host.state;
	state.jobCursor = Math.min(state.jobCursor, jobs.length - 1);
	return jobs[state.jobCursor];
}

export function openJobDetail(host: TuiHost, job: JobView): void {
	const state = host.state;
	state.jobDetailId = job.id;
	state.jobReturnToList = true;
	showPage(state, "job");
	host.render();
}

export function killSelectedJob(host: TuiHost): void {
	const job = selectedJob(host);
	if (job === undefined) return;
	host.options.jobs?.kill(job.id);
	host.render();
}

/** 让作业列表的光标始终可见。 */
export function ensureJobVisible(host: TuiHost): void {
	const state = host.state;
	const rows = Math.max(1, host.mainAreaHeight() - JOB_ACTION_HEIGHT);
	const row = 2 + state.jobCursor;
	if (row < state.pageScrollTop) state.pageScrollTop = row;
	else if (row >= state.pageScrollTop + rows) state.pageScrollTop = row - rows + 1;
}

/** 作业结束时在对话流里补一条说明。 */
export function appendJobNote(host: TuiHost, job: JobView): void {
	const elapsed = jobElapsed(job);
	const code = job.exitCode !== undefined && job.exitCode !== null ? ` · exit ${job.exitCode}` : "";
	const verb = job.status === "done" ? "finished" : job.status === "killed" ? "killed" : "failed";
	host.appendCommandTurn("/jobs", [
		{
			kind: job.status === "failed" ? "error" : "info",
			text: `Job ${job.id} ${verb} · ${job.command}${code} · ${elapsed}`,
		},
	]);
}

/** 有作业运行时每 500ms 重绘一次，空闲时也更新 Jobs bar 的耗时。 */
export function ensureJobTimer(host: TuiHost): void {
	const state = host.state;
	const running = host.options.jobs?.list().filter((job) => job.status === "running") ?? [];
	if (running.length === 0) {
		if (state.jobTimer !== undefined) {
			clearInterval(state.jobTimer);
			state.jobTimer = undefined;
		}
		return;
	}
	if (state.jobTimer !== undefined) return;
	state.jobTimer = setInterval(() => host.render(), 500);
}
