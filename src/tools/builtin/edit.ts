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
		oldText: { type: "string", description: "要替换的原文本，必须与文件中完全一致且只出现一次" },
		newText: { type: "string", description: "替换成的新文本；留空表示删除" },
	},
	required: ["oldText", "newText"],
} as const satisfies JsonSchema;

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "文件路径，相对工作根或绝对路径" },
		edits: {
			type: "array",
			description: "要应用的修改，各条互不重叠",
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
		"按片段替换文件内容。每条 oldText 必须与文件里的一段完全一致且只出现一次，" +
		"否则整次修改都不生效。要改多处就在一次调用里给多条 edits，它们都基于同一个原文。",
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
				return { content: `读取 ${displayPath} 失败：${describeError(error)}`, isError: true };
			}

			const file = decodeTextFile(buffer);
			const original = file.text;
			if (args.edits.length === 0) {
				return { content: "至少要给出一条修改", isError: true };
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
							`第 ${index} 条与第 ${index + 1} 条修改的范围重叠，无法同时应用。` +
							"请把它们合成一条，或改成不相交的片段。",
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
				return { content: `${displayPath} 的内容没有变化`, details: { path: displayPath, changed: false } };
			}

			try {
				writeFileSync(resolved.absolute, encodeTextFile(file, updated));
			} catch (error) {
				return { content: `写入 ${displayPath} 失败：${describeError(error)}`, isError: true };
			}

			const diff = formatEditDiff(original, updated, located);
			return {
				content: `已修改 ${displayPath}，共 ${located.length} 处\n\n${diff}`,
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
		return `第 ${position + 1} 条修改的 oldText 为空。删除内容请把 oldText 写成要删的那段、newText 留空。`;
	}

	const first = original.indexOf(edit.oldText);
	if (first === -1) {
		return `第 ${position + 1} 条修改的 oldText 在文件中找不到。请先用 read 确认原文的实际内容与缩进。`;
	}

	const second = original.indexOf(edit.oldText, first + 1);
	if (second !== -1) {
		return (
			`第 ${position + 1} 条修改的 oldText 在文件中出现了多次，无法确定改哪一处。` +
			"请把 oldText 扩展成带上下文的唯一片段。"
		);
	}
	return undefined;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
