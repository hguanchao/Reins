import { readFileSync, writeFileSync } from "node:fs";

import { resolveToolPath, writeScope } from "../path.ts";
import { describeError } from "../../shared/describe-error.ts";
import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { withFileMutation } from "./mutation-queue.ts";
import { decodeTextFile, encodeTextFile } from "../text-file.ts";
import { planTextEdits, type EditEntry } from "./text-edits.ts";

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
			const planned = planTextEdits(original, args.edits);
			if (!planned.ok) return { content: planned.error, isError: true };
			const { updated, located, diff } = planned.plan;

			if (updated === original) {
				return { content: `${displayPath} is unchanged`, details: { path: displayPath, changed: false } };
			}

			try {
				writeFileSync(absolute, encodeTextFile(file, updated));
			} catch (error) {
				return { content: `Failed to write ${displayPath}: ${describeError(error)}`, isError: true };
			}

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

