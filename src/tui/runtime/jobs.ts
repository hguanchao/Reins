import { jobElapsed, type JobView } from "../job.ts";
import type { TuiHost } from "./types.ts";

/**
 * 后台作业在界面上的两处残留：结束说明与刷新计时器。
 *
 * 作业页删掉之后，界面上只剩 Jobs bar 与对话流里的一条结束说明。输出与终止都交给模型
 * 的 job_output / kill_job 工具。
 */

/** 作业结束时在对话流里补一条说明。 */
export function appendJobNote(host: TuiHost, job: JobView): void {
	const elapsed = jobElapsed(job);
	const code = job.exitCode !== undefined && job.exitCode !== null ? ` · exit ${job.exitCode}` : "";
	const verb = job.status === "done" ? "finished" : job.status === "killed" ? "killed" : "failed";
	host.appendCommandTurn("jobs", [
		{
			kind: job.status === "failed" ? "error" : "info",
			text: `Job ${job.id} ${verb} · ${job.command}${code} · ${elapsed}`,
		},
	]);
}

/** 有作业运行时每 500ms 重绘一次，让 Jobs bar 的耗时跟着当前时间走。 */
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
