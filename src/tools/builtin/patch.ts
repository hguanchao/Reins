import { readFileSync, writeFileSync } from "node:fs";

import { resolveToolPath, writeScope } from "../path.ts";
import { describeError } from "../../shared/describe-error.ts";
import type { PermissionScope, ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { decodeTextFile, encodeTextFile, type TextFile } from "../text-file.ts";
import { withFileMutations } from "./mutation-queue.ts";
import { planTextEdits, type EditEntry, type PlannedEdit } from "./text-edits.ts";

/**
 * 多文件补丁。
 *
 * 与 edit 共用同一套匹配规则，但把所有目标文件先全部读入、全部校验，再统一写入：任何一条
 * oldText 找不到或不唯一时，一个文件都不动。这样一次跨文件重构不会停在「改了一半」的状态，
 * 模型也不必为每个文件各发一次调用。
 *
 * 写入不是文件系统事务：所有校验都在写之前完成，但如果写到一半磁盘出错，已经写下的文件
 * 无法自动回滚，错误里会列出它们。
 */

const EDIT_ENTRY = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path, relative to the workspace root or absolute." },
		oldText: {
			type: "string",
			description: "Exact text to replace. It must appear exactly once in that file and must not overlap another edit.",
		},
		newText: { type: "string", description: "Replacement text. Leave empty to delete." },
	},
	required: ["path", "oldText", "newText"],
} as const satisfies JsonSchema;

const PARAMETERS = {
	type: "object",
	properties: {
		edits: {
			type: "array",
			description:
				"Replacements across one or more files. Every edit is validated against the original files before any write.",
			items: EDIT_ENTRY,
		},
	},
	required: ["edits"],
} as const satisfies JsonSchema;

interface PatchEdit extends EditEntry {
	readonly path: string;
}

type PatchArgs = {
	readonly edits: readonly PatchEdit[];
};

interface FilePlan {
	readonly absolute: string;
	readonly display: string;
	readonly file: TextFile;
	readonly updated: string;
	readonly located: readonly PlannedEdit[];
	readonly diff: string;
}

export const patchTool: ToolDefinition<PatchArgs> = {
	name: "patch",
	summary: "Apply exact text replacements across multiple files in one call",
	description:
		"Change one or more text files by exact fragment replacement in a single call. Every oldText is matched " +
		"against the original file content; each must be unique within its file and must not overlap another edit. " +
		"All files are read and validated before anything is written, so one bad edit leaves every file untouched. " +
		"Use this instead of several edit calls when a change spans files.",
	parameters: PARAMETERS,
	annotations: { readOnly: false, destructive: true, openWorld: false },

	permissionScope: (args, workspace): PermissionScope | undefined => {
		const paths = [...new Set(args.edits.map((edit) => edit.path))];
		if (paths.length === 0) return undefined;
		const scopes = paths.map((path) => writeScope(workspace, path));
		const only = scopes[0];
		if (scopes.length === 1 && only !== undefined) return only;
		// 键按路径排序，同一组文件无论以什么顺序写出都落在同一个「本会话总是允许」上
		const ordered = [...scopes].sort((left, right) => left.key.localeCompare(right.key));
		return {
			key: ordered.map((scope) => scope.key).join("\n"),
			label: `files: ${scopes.map((scope) => scope.label).join(", ")}`,
			short: `${scopes.length} files`,
		};
	},

	/** 与 edit 相同的两种容忍：JSON 字符串，以及只有一条却写成对象。 */
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
		if (args.edits.length === 0) {
			return { content: "At least one edit is required", isError: true };
		}

		// 同一个文件被写多次时按给出顺序合并，避免后一条基于前一条的结果去匹配
		const groups = new Map<string, { readonly display: string; readonly edits: EditEntry[] }>();
		for (const edit of args.edits) {
			const { absolute, display } = resolveToolPath(workspace, sandbox, edit.path, "write");
			const group = groups.get(absolute);
			if (group === undefined) {
				groups.set(absolute, { display, edits: [{ oldText: edit.oldText, newText: edit.newText }] });
			} else {
				group.edits.push({ oldText: edit.oldText, newText: edit.newText });
			}
		}

		return withFileMutations([...groups.keys()], async (): Promise<ToolResult> => {
			const plans: FilePlan[] = [];
			for (const [absolute, group] of groups) {
				let buffer: Buffer;
				try {
					buffer = readFileSync(absolute);
				} catch (error) {
					return { content: `Failed to read ${group.display}: ${describeError(error)}`, isError: true };
				}

				const file = decodeTextFile(buffer);
				if (file.lossy) {
					// 非 UTF-8 文件解码时已经出现替换字符，整份写回会把原文彻底改坏
					return {
						content:
							`${group.display} is not valid UTF-8, so editing it would corrupt the file. ` +
							"Convert it to UTF-8 first, or change it with a tool that preserves the original encoding.",
						isError: true,
					};
				}

				const planned = planTextEdits(file.text, group.edits);
				if (!planned.ok) {
					return { content: `${group.display}: ${planned.error}`, isError: true };
				}
				plans.push({ absolute, display: group.display, file, ...planned.plan });
			}

			// 全部校验通过后才开始写；写失败时已经写下的文件无法回滚，错误里明确列出来
			const written: string[] = [];
			for (const plan of plans) {
				if (plan.updated === plan.file.text) continue;
				try {
					writeFileSync(plan.absolute, encodeTextFile(plan.file, plan.updated));
					written.push(plan.display);
				} catch (error) {
					const already = written.length === 0 ? "nothing was written" : `already written: ${written.join(", ")}`;
					return {
						content: `Failed to write ${plan.display}; ${already}: ${describeError(error)}`,
						isError: true,
					};
				}
			}

			const changed = plans.filter((plan) => plan.updated !== plan.file.text);
			if (changed.length === 0) {
				return { content: "No files were changed", details: { changed: false, files: [] } };
			}

			const editCount = changed.reduce((sum, plan) => sum + plan.located.length, 0);
			const body = changed.map((plan) => `### ${plan.display}\n${plan.diff}`).join("\n\n");
			return {
				content:
					`Updated ${changed.length} ${changed.length === 1 ? "file" : "files"}: ` +
					`${editCount} edits applied\n\n${body}`,
				details: {
					changed: true,
					editCount,
					files: changed.map((plan) => ({
						path: plan.display,
						editCount: plan.located.length,
						diff: plan.diff,
					})),
				},
			};
		});
	},
};
