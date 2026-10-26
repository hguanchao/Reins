import { readFileSync, writeFileSync } from "node:fs";

import { resolveToolPath, writeScope } from "../path.ts";
import { describeError } from "../../shared/describe-error.ts";
import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { formatEditDiff, type AppliedEdit } from "./diff.ts";
import { withFileMutation } from "./mutation-queue.ts";
import { decodeTextFile, encodeTextFile } from "../text-file.ts";

/**
 * 精确修改文件。
 *
 * 这个工具的语义就是产品承诺本身，所以三条规则不打折：所有片段都对原文匹配、每条必须唯一、
 * 互不重叠。含混的匹配宁可不改——猜错的编辑比不改更糟，因为使用者很可能不会逐行核对。
 */

const EDIT_ENTRY = {
	type: "object",
	properties: {
		oldText: {
			type: "string",
			description: "Exact text to replace. It must appear exactly once in the original file and must not overlap another edit.",
		},
		newText: { type: "string", description: "Replacement text. Leave empty to delete." },
	},
	required: ["oldText", "newText"],
} as const satisfies JsonSchema;

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path, relative to the workspace root or absolute." },
		edits: {
			type: "array",
			description: "Replacements applied to the original file. Fragments must not overlap.",
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
	summary: "Replace exact text fragments in an existing file",
	description:
		"Change an existing text file by exact fragment replacement. Every oldText is matched against the original " +
		"file, not against the result of earlier edits in the same call. Each fragment must be unique and must not " +
		"overlap another; merge nearby changes into one edit. Pass all changes for one file in a single call.",
	parameters: PARAMETERS,
	annotations: { readOnly: false, destructive: true, openWorld: false },

	permissionScope: (args, workspace) => writeScope(workspace, args.path),

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
		const { absolute, display: displayPath } = resolveToolPath(workspace, sandbox, args.path, "write");

		return withFileMutation(absolute, async (): Promise<ToolResult> => {
			let buffer: Buffer;
			try {
				buffer = readFileSync(absolute);
			} catch (error) {
				return { content: `Failed to read ${displayPath}: ${describeError(error)}`, isError: true };
			}

			const file = decodeTextFile(buffer);
			if (file.lossy) {
				// 非 UTF-8 文件解码时已经出现替换字符，整份写回会把原文彻底改坏。
				return {
					content:
						`${displayPath} is not valid UTF-8, so editing it would corrupt the file. ` +
						"Convert it to UTF-8 first, or change it with a tool that preserves the original encoding.",
					isError: true,
				};
			}
			const original = file.text;
			if (args.edits.length === 0) {
				return { content: "At least one edit is required", isError: true };
			}

			const located: (AppliedEdit & { readonly source: number })[] = [];
			for (const [position, edit] of args.edits.entries()) {
				const start = locateEdit(original, edit, position);
				if (typeof start === "string") return { content: start, isError: true };
				located.push({
					start,
					end: start + edit.oldText.length,
					newText: edit.newText,
					source: position + 1,
				});
			}

			located.sort((left, right) => left.start - right.start);
			for (let index = 1; index < located.length; index += 1) {
				if (located[index].start < located[index - 1].end) {
					// 报原始序号：模型按自己给的顺序去找这两条，排序后的位置对它没有意义
					return {
						content:
							`Edits ${located[index - 1].source} and ${located[index].source} overlap and cannot be applied together. ` +
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
				writeFileSync(absolute, encodeTextFile(file, updated));
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
 * 定位一条修改,返回它在原文中的起点或拒绝理由。
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

