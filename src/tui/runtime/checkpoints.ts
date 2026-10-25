import { describeError } from "../../shared/describe-error.ts";
import type { CheckpointEntry } from "../../checkpoint/service.ts";
import { CHECKPOINT_ACTION_HEIGHT } from "../page/checkpoint.ts";
import { ERROR_STATUS } from "../render/status.ts";
import { showPage } from "./pages.ts";
import type { TuiHost } from "./types.ts";

/**
 * 检查点页与撤销。
 *
 * 恢复要跑 git，页面先关掉，进度走状态行；失败通过对话流的错误行留下原因，
 * 不把使用者困在一个没有反馈的页面里。
 */

/** 关闭检查点列表/确认页，清掉临时数据。 */
export function closeCheckpointPage(host: TuiHost): void {
	const state = host.state;
	if (state.openPage === "checkpoints" || state.openPage === "checkpoint") state.openPage = undefined;
	state.checkpointPreview = undefined;
	state.checkpointList = [];
	state.checkpointCursor = 0;
	state.checkpointLoading = false;
	state.checkpointReturnToList = false;
	state.pageScrollTop = 0;
}

/** 打开检查点列表；索引已在内存里，不需要异步等待。 */
export function openCheckpointList(host: TuiHost): void {
	const source = host.options.checkpoints;
	if (source === undefined || !source.available()) {
		host.resetStatusMeta();
		host.setStatus(source?.error() ?? "Checkpoints are unavailable in this workspace", "notice");
		host.scheduleStatusClear();
		return;
	}
	const state = host.state;
	state.checkpointList = source.list();
	state.checkpointCursor = 0;
	state.checkpointPreview = undefined;
	state.checkpointReturnToList = false;
	state.checkpointLoading = false;
	showPage(state, "checkpoints");
}

/** 选中列表项后读取实际差异，再打开确认页。 */
export function loadCheckpointPreview(host: TuiHost, entry: CheckpointEntry): void {
	const source = host.options.checkpoints;
	const state = host.state;
	if (source === undefined || !source.available() || state.checkpointLoading) return;
	state.checkpointLoading = true;
	host.render();
	void source
		.preview(entry.id)
		.then((preview) => {
			state.checkpointLoading = false;
			if (state.finished) return;
			if (state.openPage !== "checkpoints") {
				host.render();
				return;
			}
			if (preview.changes.length === 0) {
				state.openPage = undefined;
				host.resetStatusMeta();
				host.setStatus("No file changes to restore", "notice");
				host.scheduleStatusClear();
				host.render();
				return;
			}
			state.checkpointPreview = preview;
			state.checkpointReturnToList = true;
			showPage(state, "checkpoint");
			host.render();
		})
		.catch((error) => {
			state.checkpointLoading = false;
			if (state.finished) return;
			if (state.openPage !== "checkpoints") {
				host.render();
				return;
			}
			state.openPage = undefined;
			host.resetStatusMeta();
			host.appendCommandTurn("/checkpoints", [{ kind: "error", text: `Error: ${describeError(error)}` }]);
			host.setStatus(ERROR_STATUS, "error");
			host.scheduleStatusClear();
			host.render();
		});
}

/** /undo:取最近一个与当前工作区有差异的回合检查点。 */
export function executeUndo(host: TuiHost): void {
	const source = host.options.checkpoints;
	const state = host.state;
	if (source === undefined || !source.available()) {
		host.resetStatusMeta();
		host.setStatus(source?.error() ?? "Checkpoints are unavailable in this workspace", "notice");
		host.scheduleStatusClear();
		return;
	}
	if (state.checkpointLoading || state.restoringCheckpoint) return;

	state.checkpointLoading = true;
	host.resetStatusMeta();
	host.setStatus("Reading checkpoints...", "notice");
	void source
		.latestUndoable()
		.then((preview) => {
			state.checkpointLoading = false;
			if (state.finished) return;
			host.clearStatus();
			if (preview === undefined) {
				host.setStatus("No file changes to undo", "notice");
				host.scheduleStatusClear();
				host.render();
				return;
			}
			state.checkpointPreview = preview;
			state.checkpointReturnToList = false;
			showPage(state, "checkpoint");
			host.render();
		})
		.catch((error) => {
			state.checkpointLoading = false;
			if (state.finished) return;
			host.resetStatusMeta();
			host.setStatus(`Undo unavailable: ${describeError(error)}`, "error");
			host.scheduleStatusClear();
			host.render();
		});
}

/** 恢复当前确认页里的检查点。 */
export function restoreCheckpoint(host: TuiHost): void {
	const state = host.state;
	const preview = state.checkpointPreview;
	const source = host.options.checkpoints;
	if (
		preview === undefined ||
		preview.changes.length === 0 ||
		source === undefined ||
		state.restoringCheckpoint
	) {
		return;
	}
	if (host.options.jobs?.list().some((job) => job.status === "running") === true) {
		// 后台作业可能正在写同一批文件；先让它停下来，否则恢复出来的工作区不是任何一个稳定状态
		closeCheckpointPage(host);
		host.resetStatusMeta();
		host.setStatus("Stop background jobs before restoring files", "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	state.restoringCheckpoint = true;
	state.checkpointPreview = undefined;
	state.checkpointList = [];
	state.checkpointCursor = 0;
	state.checkpointLoading = false;
	state.checkpointReturnToList = false;
	state.openPage = undefined;
	state.pageScrollTop = 0;
	host.setInput("");
	host.resetStatusMeta();
	host.setStatus("Restoring checkpoint...", "notice");
	host.render();

	void source
		.restore(preview.entry.id)
		.then((result) => {
			state.restoringCheckpoint = false;
			if (state.finished) return;
			const verb = result.entry.kind === "safety" ? "Restored" : "Undid";
			const removed = result.removed > 0 ? `, ${result.removed} removed` : "";
			host.appendCommandTurn("/undo", [
				{
					kind: "info",
					text: `${verb} ${result.entry.label} · ${result.restored} restored${removed}`,
				},
			]);
			host.clearStatus();
			host.render();
		})
		.catch((error) => {
			state.restoringCheckpoint = false;
			if (state.finished) return;
			host.appendCommandTurn("/undo", [{ kind: "error", text: `Error: ${describeError(error)}` }]);
			host.setStatus(ERROR_STATUS, "error");
			host.scheduleStatusClear();
			host.render();
		});
}

/** 让检查点列表的光标始终落在可见区内。 */
export function ensureCheckpointVisible(host: TuiHost): void {
	const state = host.state;
	const rows = Math.max(1, host.mainAreaHeight() - CHECKPOINT_ACTION_HEIGHT);
	const row = (state.checkpointLoading ? 3 : 2) + state.checkpointCursor;
	if (row < state.pageScrollTop) state.pageScrollTop = row;
	else if (row >= state.pageScrollTop + rows) state.pageScrollTop = row - rows + 1;
}
