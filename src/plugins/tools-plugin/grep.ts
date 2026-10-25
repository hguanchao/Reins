import { readFileSync } from "node:fs";

import { resolveToolPath } from "../../tools/tool-path.ts";
import { describeError } from "../../describe-error.ts";
import type { ToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { JsonSchema } from "../../tools/schema.ts";
import { BINARY_PROBE_BYTES, decodeTextFile, looksBinary } from "../../tools/builtin/text-file.ts";
import { MAX_LINE_LENGTH, truncateLine } from "../../tools/truncate.ts";
import { fileEntries, globToRegExp, MAX_WALK_ENTRIES } from "../../workspace/walk.ts";

/**
 * 按内容检索。
 *
 * 自己逐行扫，不依赖外部检索工具：这样在任何环境里都可用，不必先装什么，也不必在缺失时
 * 退回另一套行为。代价是在超大目录树上比专门的工具慢——需要那种速度时，把它作为插件替换掉
 * 即可，这正是它被放在插件里的原因。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		pattern: { type: "string", description: "Regular expression to match, or plain text when literal is true." },
		path: { type: "string", description: "Directory to search; defaults to the workspace root." },
		glob: { type: "string", description: "Only search files matching this glob, e.g. **/*.ts." },
		literal: { type: "boolean", description: "Treat pattern as plain text instead of a regular expression." },
		ignoreCase: { type: "boolean", description: "Match case-insensitively." },
		limit: { type: "integer", minimum: 1, description: "Maximum matches to return; defaults to 100." },
	},
	required: ["pattern"],
} as const satisfies JsonSchema;

type GrepArgs = {
	readonly pattern: string;
	readonly path?: string;
	readonly glob?: string;
	readonly literal?: boolean;
	readonly ignoreCase?: boolean;
	readonly limit?: number;
};

const DEFAULT_LIMIT = 100;
/** 单个文件的大小上限。更大的多半是生成物或数据，扫它只是白花时间。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 判断内容的探查范围。 */
export const grepTool: ToolDefinition<GrepArgs> = {
	name: "grep",
	summary: "Search file contents for a pattern",
	description:
		"Search file contents recursively and return matches as \"path:line: text\". The pattern is a regular " +
		"expression unless literal is true. Starts from path (default: workspace root), honors an optional glob, " +
		"skips .git and node_modules, and stops at the limit.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const { absolute } = resolveToolPath(workspace, sandbox, args.path ?? ".", "read");
		const limit = args.limit ?? DEFAULT_LIMIT;

		let matcher: RegExp;
		try {
			const source = args.literal === true ? escapeRegExp(args.pattern) : args.pattern;
			matcher = new RegExp(source, args.ignoreCase === true ? "i" : "");
		} catch (error) {
			return { content: `pattern is not a valid regular expression: ${describeError(error)}`, isError: true };
		}

		const fileMatcher = args.glob === undefined ? undefined : globToRegExp(args.glob);
		const matches: string[] = [];
		let scannedFiles = 0;

		for (const entry of fileEntries(absolute, MAX_WALK_ENTRIES)) {
			const relativePath = workspace.display(entry.absolute);
			if (fileMatcher !== undefined && !fileMatcher.test(entry.relative) && !fileMatcher.test(relativePath)) {
				continue;
			}

			scannedFiles += 1;
			const text = readTextOrSkip(entry.absolute);
			if (text === undefined) continue;

			const lines = text.split("\n");
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				if (!matcher.test(line)) continue;
				matches.push(`${relativePath}:${index + 1}: ${truncateLine(line, MAX_LINE_LENGTH)}`);
				if (matches.length >= limit) break;
			}
			if (matches.length >= limit) break;
			// 同步读文件会占住事件循环；每扫一批让界面有机会刷新与处理 Ctrl+C
			if (scannedFiles % 50 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		}

		if (matches.length === 0) {
			return { content: `No matches for "${args.pattern}" (${scannedFiles} files checked)` };
		}

		const parts = [matches.join("\n")];
		if (matches.length >= limit) parts.push(`[hit the limit of ${limit}; narrow the search with glob or raise limit]`);
		return { content: parts.join("\n\n"), details: { pattern: args.pattern, matched: matches.length } };
	},
};

/** 读文本；二进制或过大的文件跳过，返回 undefined。 */
function readTextOrSkip(path: string): string | undefined {
	try {
		const buffer = readFileSync(path);
		if (buffer.length > MAX_FILE_BYTES) return undefined;
		if (looksBinary(buffer, BINARY_PROBE_BYTES)) return undefined;
		// 与 read 共用同一套解码：UTF-16 文件按 UTF-8 解出来会是一串乱码
		return decodeTextFile(buffer).text;
	} catch {
		return undefined;
	}
}

function escapeRegExp(text: string): string {
	return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

