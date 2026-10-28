import { formatEditDiff, type AppliedEdit } from "./diff.ts";

/**
 * 文本替换的匹配与规划。
 *
 * edit 与 patch 共用同一套规则：每条 oldText 都对原文匹配、必须唯一、互不重叠。抽出来是因为
 * 两条路径若各写一遍，迟早在「重复匹配怎么报错」或「重叠如何判定」上分叉，而这两件事正是
 * 防止模型改错文件的关键。
 */

export interface EditEntry {
	readonly oldText: string;
	readonly newText: string;
}

/** 一处已经定位的替换；source 是调用方给的序号，报错时用它而不是排序后的位置。 */
export interface PlannedEdit extends AppliedEdit {
	readonly source: number;
}

export interface EditPlan {
	readonly updated: string;
	readonly located: readonly PlannedEdit[];
	readonly diff: string;
}

export type EditPlanResult =
	| { readonly ok: true; readonly plan: EditPlan }
	| { readonly ok: false; readonly error: string };

/** 规划一次文本替换；任何一条不合法都不产出结果。 */
export function planTextEdits(original: string, edits: readonly EditEntry[]): EditPlanResult {
	if (edits.length === 0) return { ok: false, error: "At least one edit is required" };

	const located: PlannedEdit[] = [];
	for (const [position, edit] of edits.entries()) {
		const start = locateEdit(original, edit, position);
		if (typeof start === "string") return { ok: false, error: start };
		located.push({
			start,
			end: start + edit.oldText.length,
			newText: edit.newText,
			source: position + 1,
		});
	}

	located.sort((left, right) => left.start - right.start);
	for (let index = 1; index < located.length; index += 1) {
		const previous = located[index - 1];
		const current = located[index];
		if (previous === undefined || current === undefined) continue;
		if (current.start < previous.end) {
			// 报原始序号：模型按自己给的顺序去找这两条，排序后的位置对它没有意义
			return {
				ok: false,
				error:
					`Edits ${previous.source} and ${current.source} overlap and cannot be applied together. ` +
					"Merge them into one edit, or make the fragments disjoint.",
			};
		}
	}

	// 从后往前替换：靠前的偏移因此不受影响，不必重新计算位置
	let updated = original;
	for (const edit of [...located].reverse()) {
		updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
	}

	return { ok: true, plan: { updated, located, diff: formatEditDiff(original, updated, located) } };
}

/**
 * 定位一条修改，返回它在原文中的起点或拒绝理由。
 *
 * oldText 为空必须拒绝：`indexOf("")` 恒为 0，放过去会变成「在文件开头插入」，而使用者的
 * 本意绝不是这个。
 */
function locateEdit(original: string, edit: EditEntry, position: number): number | string {
	if (edit.oldText.length === 0) {
		return `Edit ${position + 1} has an empty oldText. To delete content, set oldText to the text to delete and leave newText empty.`;
	}

	const first = original.indexOf(edit.oldText);
	if (first === -1) {
		return `Edit ${position + 1}: oldText was not found in the file. Use read to check the exact content and indentation.`;
	}

	const second = original.indexOf(edit.oldText, first + 1);
	if (second !== -1) {
		return (
			`Edit ${position + 1}: oldText appears more than once in the file, so the target is ambiguous. ` +
			"Extend oldText with enough context to make it unique."
		);
	}
	return first;
}
