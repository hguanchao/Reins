import { describeError } from "../../shared/describe-error.ts";
import { ERROR_STATUS } from "../render/status.ts";
import type { TuiHost } from "./types.ts";

/**
 * /undo:恢复最近一个与当前工作区有差异的回合检查点。
 *
 * 没有页面可确认，所以恢复直接执行，结果通过对话流留下记录。恢复要跑 git，期间工作区
 * 必须是稳定状态：回合在跑或审查在读工作区时明确拒绝，不做一半的恢复。
 */

/** /undo:取最近一个与当前工作区有差异的回合检查点并恢复。 */
export function executeUndo(host: TuiHost): void {
	const source = host.options.checkpoints;
	const state = host.state;
	if (source === undefined || !source.available()) {
		host.resetStatusMeta();
		host.setStatus(source?.error() ?? "Checkpoints are unavailable in this workspace", "notice");
		host.scheduleStatusClear();
		return;
	}
	if (state.restoringCheckpoint) return;
	if (state.reviewing) {
		// 审查子代理正在读工作区：此时恢复文件会让结论建立在变动中的内容上
		host.resetStatusMeta();
		host.setStatus("A review is running; wait for it to finish before restoring files", "notice");
		host.scheduleStatusClear();
		return;
	}

	state.restoringCheckpoint = true;
	host.resetStatusMeta();
	host.setStatus("Reading checkpoints...", "notice");
	host.render();
	void source
		.latestUndoable()
		.then((preview) => {
			if (state.finished) return;
			// 读检查点要跑 git，期间使用者可能已经提交了新的一轮；回合在改文件时也不能恢复
			if (state.activeTurn !== undefined || state.reviewing || preview === undefined || preview.changes.length === 0) {
				state.restoringCheckpoint = false;
				host.setStatus(
					preview === undefined || preview.changes.length === 0
						? "No file changes to undo"
						: "Wait for the running turn to finish before restoring files",
					"notice",
				);
				host.scheduleStatusClear();
				host.render();
				return;
			}
			host.clearStatus();
			host.render();
			return source
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
		})
		.catch((error) => {
			state.restoringCheckpoint = false;
			if (state.finished) return;
			host.resetStatusMeta();
			host.setStatus(`Undo unavailable: ${describeError(error)}`, "error");
			host.scheduleStatusClear();
			host.render();
		});
}
