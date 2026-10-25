import { formatDuration } from "../tools/format.ts";
import { displayWidth, truncateToWidth } from "./text.ts";
import { THEME } from "./theme.ts";

/**
 * 后台作业列表与输出页。
 *
 * 列表只回答「有哪些作业、现在什么状态」；输出页负责看日志。两者和检查点页一样固定
 * 底部动作条，滚轮/PageUp/PageDown 只滚正文。
 */

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface JobView {
	readonly id: string;
	readonly command: string;
	readonly status: JobStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly exitCode?: number | null;
	readonly timedOut?: boolean;
	readonly overflowed?: boolean;
	readonly sessionId: string;
}

export interface JobEvent {
	readonly type: "started" | "finished";
	readonly job: JobView;
}

export const JOB_ACTION_HEIGHT = 2;

const LIST_TITLE = "Reins — jobs";
const OUTPUT_TITLE = "Reins — jobs · ";
const RESET = THEME.reset;
const META_COLOR = THEME.textSecondary;
const SUBTLE_COLOR = THEME.textSubtle;
const RUNNING_COLOR = THEME.accent;
const DONE_COLOR = THEME.success;
const FAILED_COLOR = THEME.error;
const KILLED_COLOR = THEME.warning;
/** 输出页最多展示尾部多少行；更早的内容仍保留在 JobManager 的缓冲里。 */
const MAX_OUTPUT_LINES = 2000;

export function jobListLines(jobs: readonly JobView[], width: number, cursor: number): readonly string[] {
	const columns = Math.max(0, width);
	const lines = [title(LIST_TITLE, columns), " ".repeat(columns)];
	if (jobs.length === 0) {
		lines.push(subtleLine("No background jobs yet.", columns));
		lines.push(subtleLine("Long commands started with background: true appear here.", columns));
		return lines;
	}

	jobs.forEach((job, index) => lines.push(jobRow(job, columns, index === cursor)));
	lines.push(subtleLine("Jobs are killed when Reins exits.", columns));
	return lines;
}

export function jobOutputLines(job: JobView, output: string, width: number): readonly string[] {
	const columns = Math.max(0, width);
	const lines = [
		title(`${OUTPUT_TITLE}${job.id}`, columns),
		" ".repeat(columns),
		`${RUNNING_COLOR}  ${truncateToWidth(job.command, Math.max(0, columns - 2))}${RESET}`,
		`${META_COLOR}  ${truncateToWidth(jobSummary(job), Math.max(0, columns - 2))}${RESET}`,
		" ".repeat(columns),
	];

	const clean = output
		.split("\n")
		.map((line) => line.replace(/\t/g, "    "));
	const start = Math.max(0, clean.length - MAX_OUTPUT_LINES);
	if (start > 0) {
		lines.push(subtleLine(`… ${start} earlier lines omitted · full output stays in the job buffer`, columns));
	}
	if (clean.length === 0 || (clean.length === 1 && clean[0] === "")) {
		lines.push(subtleLine("[no output yet]", columns));
		return lines;
	}
	for (const line of clean.slice(start)) {
		lines.push(truncateToWidth(line, columns));
	}
	if (job.overflowed === true) {
		lines.push(subtleLine("[earlier output was dropped after the buffer filled]", columns));
	}
	return lines;
}

export function jobListActions(width: number): readonly string[] {
	return actionLines(width, [
		["↑/↓", "select", THEME.accent],
		["Enter", "view output", THEME.accent],
		["k", "kill", THEME.warning],
		["Esc", "close", THEME.textSubtle],
	]);
}

export function jobOutputActions(width: number, status: JobStatus): readonly string[] {
	const keys: (readonly [string, string, string])[] = [
		["k", "kill", THEME.warning],
		["Esc", "back", THEME.textSubtle],
	];
	if (status !== "running") keys.shift();
	return actionLines(width, keys);
}

function jobRow(job: JobView, width: number, selected: boolean): string {
	const marker = selected ? "▸ " : "  ";
	const id = job.id.padEnd(4);
	const status = jobStatusLabel(job);
	const detail = jobDetail(job);
	const leftPlain = `${marker}${id}  ${job.command}`;
	const leftWidth = displayWidth(leftPlain);
	const right = `${status}  ${detail}`;
	const fitsRight = leftWidth + 2 + displayWidth(right) <= width;
	const shownLeft = truncateToWidth(
		leftPlain,
		fitsRight ? width - displayWidth(right) - 2 : width,
	);
	const padding = " ".repeat(
		Math.max(0, width - displayWidth(shownLeft) - (fitsRight ? displayWidth(right) : 0)),
	);
	const left = `${selected ? THEME.accent : THEME.textPrimary}${shownLeft}${RESET}`;
	if (!fitsRight) return `${left}${padding}`;
	return `${left}${padding}${statusColor(job.status)}${status}${RESET}  ${SUBTLE_COLOR}${detail}${RESET}`;
}

function jobStatusLabel(job: JobView): string {
	switch (job.status) {
		case "running":
			return "running";
		case "done":
			return "done";
		case "failed":
			return "failed";
		default:
			return "killed";
	}
}

function statusColor(status: JobStatus): string {
	switch (status) {
		case "running":
			return RUNNING_COLOR;
		case "done":
			return DONE_COLOR;
		case "failed":
			return FAILED_COLOR;
		default:
			return KILLED_COLOR;
	}
}

function jobDetail(job: JobView): string {
	const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
	if (job.status === "running") return elapsed;
	if (job.timedOut === true) return `timeout · ${elapsed}`;
	if (job.exitCode !== undefined && job.exitCode !== null) return `exit ${job.exitCode} · ${elapsed}`;
	return elapsed;
}

function jobSummary(job: JobView): string {
	const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
	const parts = [job.status, elapsed];
	if (job.exitCode !== undefined && job.exitCode !== null) parts.push(`exit ${job.exitCode}`);
	if (job.timedOut === true) parts.push("timed out");
	return parts.join(" · ");
}

function actionLines(
	width: number,
	keys: readonly (readonly [string, string, string])[],
): readonly string[] {
	const columns = Math.max(0, width);
	const rule = `${THEME.border}${"─".repeat(columns)}${RESET}`;
	if (columns === 0) return ["", ""];
	const text = keys
		.map(([key, label, color]) => `${color}${key}${RESET} ${META_COLOR}${label}${RESET}`)
		.join("  ");
	const plain = keys.map(([key, label]) => `${key} ${label}`).join("  ");
	const visible = displayWidth(plain) <= columns ? text : truncateToWidth(plain, columns);
	const used = displayWidth(plain) <= columns ? displayWidth(plain) : displayWidth(visible);
	return [rule, `${visible}${" ".repeat(Math.max(0, columns - used))}`];
}

function title(text: string, width: number): string {
	const shown = truncateToWidth(text, width);
	return `${THEME.accent}${shown}${RESET}${" ".repeat(Math.max(0, width - displayWidth(shown)))}`;
}

function subtleLine(text: string, width: number): string {
	return `${SUBTLE_COLOR}  ${truncateToWidth(text, Math.max(0, width - 2))}${RESET}`;
}
