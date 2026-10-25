import type { CheckpointEntry, CheckpointPreview } from "../../checkpoint/service.ts";
import { actionLines, pageTitle, subtleLine } from "./chrome.ts";
import { displayWidth, truncateToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 检查点列表与撤销确认页。
 *
 * 列表负责选点，确认页负责说明“这次恢复会动哪些文件”。两者都不显示行级 diff：撤销看的是
 * 范围和后果，逐行细节留给编辑器。动作条固定在视口底部，和计划审批页保持同一套节奏。
 */

/** 底部固定区：一条分隔线加一行动作。 */
export const CHECKPOINT_ACTION_HEIGHT = 2;

const LIST_TITLE = "Reins — checkpoints";
const UNDO_TITLE = "Reins — undo";
const RESTORE_TITLE = "Reins — restore";
const RESET = THEME.reset;
const TIME_COLOR = THEME.textSubtle;
const SAFETY_COLOR = THEME.syntaxKeyword;
const SELECTED_COLOR = THEME.accent;

/** 列表正文。 */
export function checkpointListLines(
	entries: readonly CheckpointEntry[],
	width: number,
	cursor: number,
	busy = false,
): readonly string[] {
	const columns = Math.max(0, width);
	const lines = [pageTitle(LIST_TITLE, columns), " ".repeat(columns)];
	if (busy) lines.push(subtleLine("Reading checkpoint…", columns));
	if (entries.length === 0) {
		lines.push(subtleLine("No checkpoints yet.", columns));
		lines.push(subtleLine("A checkpoint is created when a turn starts.", columns));
		return lines;
	}

	entries.forEach((entry, index) => {
		lines.push(checkpointRow(entry, columns, index === cursor));
	});
	lines.push(subtleLine("Last 20 checkpoints · only available in a Git repository.", columns));
	return lines;
}

/** 确认页正文：目标、文件状态与恢复后果。 */
export function checkpointPreviewLines(preview: CheckpointPreview, width: number): readonly string[] {
	const columns = Math.max(0, width);
	const entry = preview.entry;
	const title = entry.kind === "safety" ? RESTORE_TITLE : UNDO_TITLE;
	const count = preview.changes.length;
	const lines = [pageTitle(title, columns), " ".repeat(columns)];
	const meta = [
		entry.label,
		checkpointAge(entry.createdAt),
		count === 0 ? "no changes" : `${count} ${count === 1 ? "file" : "files"}`,
	].join(" · ");
	lines.push(`${entry.kind === "safety" ? SAFETY_COLOR : THEME.accent}  ${truncateToWidth(meta, Math.max(0, columns - 2))}${RESET}`);

	if (count === 0) {
		lines.push(" ".repeat(columns));
		lines.push(subtleLine("This checkpoint matches the current workspace.", columns));
		return lines;
	}

	lines.push(" ".repeat(columns));
	for (const change of preview.changes) {
		const status =
			change.status === "added" ? "A" : change.status === "deleted" ? "D" : "M";
		const color =
			change.status === "added" ? THEME.success : change.status === "deleted" ? THEME.error : THEME.warning;
		const note =
			change.status === "added" ? "will be removed" : "will be restored";
		const prefix = `  ${status}  `;
		// 极窄屏先让说明消失，保留至少一列路径；否则这一行会被说明撑出终端宽度
		const showNote = columns >= displayWidth(prefix) + displayWidth(note) + 1;
		const noteWidth = showNote ? displayWidth(note) : 0;
		const pathWidth = Math.max(0, columns - displayWidth(prefix) - noteWidth);
		const shownPath = truncateToWidth(change.path, pathWidth);
		const padding = " ".repeat(
			Math.max(0, columns - displayWidth(prefix) - displayWidth(shownPath) - noteWidth),
		);
		lines.push(
			`${THEME.textSubtle}  ${color}${status}${RESET}  ${THEME.textPrimary}${shownPath}${RESET}${padding}${showNote ? `${THEME.textSubtle}${note}${RESET}` : ""}`,
		);
	}

	lines.push(" ".repeat(columns));
	lines.push(noteLine("Current files, including manual edits, will be overwritten.", THEME.warning, columns));
	lines.push(noteLine("A safety checkpoint will be kept before restoring.", THEME.textSecondary, columns));
	return lines;
}

function noteLine(text: string, color: string, width: number): string {
	return `${color}  ${truncateToWidth(text, Math.max(0, width - 2))}${RESET}`;
}

/** 列表动作条。 */
export function checkpointListActions(width: number): readonly string[] {
	return actionLines(width, [
		["↑/↓", "select", THEME.accent],
		["Enter", "view & restore", THEME.accent],
		["Esc", "close", THEME.textSubtle],
	]);
}

/** 确认页动作条；安全点用“restore”，回合检查点用“undo”。 */
export function checkpointPreviewActions(
	width: number,
	kind: CheckpointEntry["kind"],
): readonly string[] {
	return actionLines(width, [
		["u", kind === "safety" ? "restore this checkpoint" : "undo these changes", THEME.accent],
		["Esc", "cancel", THEME.textSubtle],
	]);
}

function checkpointRow(entry: CheckpointEntry, width: number, selected: boolean): string {
	const prefix = selected ? "▸ " : "  ";
	const labelColor =
		entry.kind === "safety" ? SAFETY_COLOR : selected ? SELECTED_COLOR : THEME.textPrimary;
	const label = `${prefix}${entry.label}`;
	const changes =
		entry.changes === undefined ? "…" : entry.changes === 0 ? "no changes" : `${entry.changes} ${entry.changes === 1 ? "file" : "files"}`;
	const time = checkpointAge(entry.createdAt);
	const leftPlain = `${label}  ${changes}`;
	const leftWidth = displayWidth(leftPlain);
	const fitsTime = leftWidth + 2 + displayWidth(time) <= width;
	const shownTime = fitsTime ? time : "";
	const shownLeft = truncateToWidth(leftPlain, fitsTime ? width - displayWidth(shownTime) - 2 : width);
	const padding = " ".repeat(
		Math.max(0, width - displayWidth(shownLeft) - displayWidth(shownTime)),
	);
	const labelPart = `${labelColor}${shownLeft}${RESET}`;
	return `${labelPart}${padding}${shownTime.length === 0 ? "" : `${TIME_COLOR}${shownTime}${RESET}`}`;
}

/** 检查点时间的短描述；只用相对时间，不要求同步时区。 */
export function checkpointAge(createdAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
