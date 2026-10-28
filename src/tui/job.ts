import { formatDuration } from "../shared/format.ts";
import type { JobView } from "../tools/jobs.ts";
import { THEME } from "./render/theme.ts";
import { displayWidth, sanitizeForDisplay, truncateToWidth } from "./render/text.ts";

/**
 * 后台作业在界面里还需要的部分。
 *
 * 页面删掉之后，剩下的只有两处：页脚上方那行 Jobs bar，和作业结束时的对话流说明。
 * 数据形状由 JobManager 决定，界面只读同一份声明。
 */

export type { JobEvent, JobStatus, JobView } from "../tools/jobs.ts";

export function jobElapsed(job: JobView): string {
	return formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
}

/**
 * 页脚上方的一行作业状态；有多个时只展示最新一条。
 *
 * running 行由界面按当前时间重算耗时，所以这里接收已经筛好的作业清单而不是数据源。
 */
export function renderJobBarLine(jobs: readonly JobView[], width: number): string {
	const running = jobs.filter((job) => job.status === "running");
	const newest = running[0];
	if (newest === undefined) return "";
	const finished = jobs.length - running.length;
	const prefix = " ◎ Jobs";
	const count = `${running.length} running${finished === 0 ? "" : ` · ${finished} finished`}`;
	const detail = `${singleLine(newest.command)} · ${jobElapsed(newest)} · ${newest.id}`;
	const head = `${THEME.accent}${prefix}${THEME.reset}  ${THEME.textSecondary}${count}${THEME.reset}`;
	const headWidth = displayWidth(prefix) + 2 + displayWidth(count);
	const detailWidth = 2 + displayWidth(detail);

	if (headWidth + detailWidth <= width) {
		const gap = " ".repeat(width - headWidth - detailWidth);
		return `${head}  ${THEME.textSubtle}${detail}${THEME.reset}${gap}`;
	}
	const plain = truncateToWidth(`${prefix}  ${count}`, width);
	return `${THEME.textSecondary}${plain}${" ".repeat(Math.max(0, width - displayWidth(plain)))}${THEME.reset}`;
}

/** 命令是模型给的文本：压成一行并清掉控制序列，单行高度才不会被撑开。 */
function singleLine(text: string): string {
	return sanitizeForDisplay(text).replace(/\s+/g, " ").trim();
}
