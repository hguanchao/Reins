import { readFileSync, writeFileSync } from "node:fs";

import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { formatEditDiff, type AppliedEdit } from "./edit-diff.ts";
import { withFileMutation } from "./file-mutation-queue.ts";
import { decodeTextFile, encodeTextFile } from "./text-file.ts";

/**
 * 精确修改文件。
 *
 * 这个工具的语义就是产品承诺本身，所以三条规则不打折：所有片段都对原文匹配、每条必须唯一、
 * 互不重叠。含混的匹配宁可不改——猜错的编辑比不改更糟，因为使用者很可能不会逐行核对。
 */

const EDIT_ENTRY = {
	type: "object",
	properties: {
		oldText: { type: "string", description: "The text to replace. It must match the file exactly and appear only once." },
		newText: { type: "string", description: "The replacement text. Leave empty to delete." },
	},
	required: ["oldText", "newText"],
} as const satisfies JsonSchema;

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "The path to edit, relative to the workspace root or absolute." },
		edits: {
			type: "array",
			description: "The edits to apply. Their ranges must not overlap.",
			items: EDIT_ENTRY,
		},
	},
	required: ["path", "edits"],
} as const satisfies JsonSchema;

interface EditEntry {
	readonly oldText: string;
	readonly newText: string;
}

type EditArgs = {
	readonly path: string;
	readonly edits: readonly EditEntry[];
};

export const editTool: ToolDefinition<EditArgs> = {
	name: "edit",
	description:
		"Replace file content by fragment. Each oldText must match one fragment of the file exactly and appear only " +
		"once, otherwise no edit is applied. To change several places, pass multiple edits in one call; they all apply " +
		"to the same original content.",
	parameters: PARAMETERS,
	annotations: { readOnly: false, destructive: true, openWorld: false },

	/**
	 * 容忍两种见过的写法：把 edits 写成 JSON 字符串，以及只给一条却写成了对象而不是数组。
	 * 这两种在实际交互里反复出现，让模型重发一次不如直接接受。
	 */
	prepareArguments(args: Record<string, unknown>): Record<string, unknown> {
		const edits = args["edits"];
		if (typeof edits === "string") {
			try {
				const parsed: unknown = JSON.parse(edits);
				return { ...args, edits: Array.isArray(parsed) ? parsed : [parsed] };
			} catch {
				return args;
			}
		}
		if (edits !== null && typeof edits === "object" && !Array.isArray(edits)) {
			return { ...args, edits: [edits] };
		}
		return args;
	},

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path);
		sandbox.assertPathAllowed("write", resolved.absolute);
		const displayPath = workspace.display(resolved.absolute);

		return withFileMutation(resolved.absolute, async (): Promise<ToolResult> => {
			let buffer: Buffer;
			try {
				buffer = readFileSync(resolved.absolute);
			} catch (error) {
				return { content: `Failed to read ${displayPath}: ${describeError(error)}`, isError: true };
			}

			const file = decodeTextFile(buffer);
			const original = file.text;
			if (args.edits.length === 0) {
				return { content: "At least one edit is required", isError: true };
			}

			const located: AppliedEdit[] = [];
			for (const [position, edit] of args.edits.entries()) {
				const problem = rejectEdit(original, edit, position);
				if (problem !== undefined) return { content: problem, isError: true };

				const start = original.indexOf(edit.oldText);
				located.push({ start, end: start + edit.oldText.length, newText: edit.newText });
			}

			located.sort((left, right) => left.start - right.start);
			for (let index = 1; index < located.length; index += 1) {
				if (located[index].start < located[index - 1].end) {
					return {
						content:
							`Edits ${index} and ${index + 1} overlap and cannot be applied together. ` +
							"Merge them into one edit, or make the fragments disjoint.",
						isError: true,
					};
				}
			}

			// 从后往前替换：靠前的偏移因此不受影响，不必重新计算位置
			let updated = original;
			for (const edit of [...located].reverse()) {
				updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
			}

			if (updated === original) {
				return { content: `${displayPath} is unchanged`, details: { path: displayPath, changed: false } };
			}

			try {
				writeFileSync(resolved.absolute, encodeTextFile(file, updated));
			} catch (error) {
				return { content: `Failed to write ${displayPath}: ${describeError(error)}`, isError: true };
			}

			const diff = formatEditDiff(original, updated, located);
			return {
				content: `Updated ${displayPath}: ${located.length} edits applied\n\n${diff}`,
				details: {
					path: displayPath,
					changed: true,
					editCount: located.length,
					diff,
				},
			};
		});
	},
};

/**
 * 检查一条修改能否定位，返回拒绝理由或 undefined。
 *
 * oldText 为空必须拒绝：`indexOf("")` 恒为 0，放过去会变成「在文件开头插入」，而使用者的
 * 本意绝不是这个。
 */
function rejectEdit(original: string, edit: EditEntry, position: number): string | undefined {
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
	return undefined;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
