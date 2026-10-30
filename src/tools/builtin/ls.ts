import { readdirSync, statSync } from "node:fs";

import { resolveToolPath } from "#src/tools/path.ts";
import { describeError } from "#src/shared/describe-error.ts";
import type { ToolDefinition, ToolResult } from "#src/tools/contract.ts";
import type { JsonSchema } from "#src/tools/schema.ts";
import { walk, type WalkEntry } from "#src/workspace/walk.ts";

/**
 * 列出一层目录。
 *
 * 只列一层，递归交给 find：把整棵树塞进一次结果会让大仓库的 ls 又慢又占上下文，模型也很
 * 难从几百行里找到自己关心的那一层。遍历仍走 walk，所以 .gitignore 与 .git 的过滤口径和
 * find/grep 一致。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "Directory to list; defaults to the workspace root." },
		limit: {
			type: "integer",
			minimum: 1,
			description: "Maximum entries to return; defaults to 500.",
		},
	},
	required: [],
} as const satisfies JsonSchema;

type LsArgs = {
	readonly path?: string;
	readonly limit?: number;
};

const DEFAULT_LIMIT = 500;
/** 单次列出的硬上限；再大的目录应该用 find 收窄。 */
const MAX_LIMIT = 5_000;

export const lsTool: ToolDefinition<LsArgs> = {
	name: "ls",
	summary: "List one directory level",
	description:
		"List the entries of one directory, directories first. Only one level is listed; use find to search " +
		"recursively. Respects .gitignore and does not follow symlinks. Stops after limit entries.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const { absolute, display } = resolveToolPath(workspace, sandbox, args.path ?? ".", "read");

		try {
			if (!statSync(absolute).isDirectory()) {
				return { content: `${display} is not a directory`, isError: true };
			}
			// walk 会静默跳过读不了的目录；根目录读不了时必须明确报错，不能假装它是空的
			readdirSync(absolute);
		} catch (error) {
			return { content: `Cannot list ${display}: ${describeError(error)}`, isError: true };
		}

		const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
		const entries: WalkEntry[] = [];
		let truncated = false;
		for (const entry of walk(absolute, { maxEntries: limit + 1, maxDepth: 1 })) {
			if (entries.length >= limit) {
				truncated = true;
				break;
			}
			entries.push(entry);
		}

		entries.sort((left, right) => {
			if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
			return left.relative.localeCompare(right.relative);
		});

		const rootLabel = display.endsWith("/") ? display : `${display}/`;
		const details = { path: display, total: entries.length, shown: entries.length, truncated };
		if (entries.length === 0) {
			return { content: `${rootLabel}\n(empty)`, details };
		}

		const lines = entries.map((entry) =>
			entry.kind === "directory" ? `${entry.relative}/` : entry.relative,
		);
		if (truncated) {
			lines.push(`[listing stopped after ${limit} entries; narrow the path or raise limit]`);
		}
		return { content: `${rootLabel}\n${lines.join("\n")}`, details };
	},
};
