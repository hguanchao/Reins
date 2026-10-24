import { readFileSync, statSync } from "node:fs";

import { resolveToolPath } from "../tool-path.ts";
import { describeError } from "../../describe-error.ts";
import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { DEFAULT_LIMITS, splitLines, truncateHead } from "../truncate.ts";
import { BINARY_PROBE_BYTES, decodeTextFile, looksBinary, type TextFile } from "./text-file.ts";

/**
 * 读取文件。
 *
 * 输出按行给出并带行号区间，截断只发生在行边界上：模型据此决定要不要接着读，而半行会让它
 * 误以为内容到此为止。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path, relative to the workspace root or absolute." },
		offset: { type: "integer", minimum: 1, description: "1-based line number to start reading from." },
		limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
	},
	required: ["path"],
} as const satisfies JsonSchema;

type ReadArgs = {
	readonly path: string;
	readonly offset?: number;
	readonly limit?: number;
};

export const readTool: ToolDefinition<ReadArgs> = {
	name: "read",
	summary: "Read a text file; use offset and limit for large files",
	description:
		`Read a text file from the workspace and return its content. A call returns at most ` +
		`${DEFAULT_LIMITS.maxLines} lines or ${DEFAULT_LIMITS.maxBytes / 1024} KB; when there is more, the result ` +
		"reports the line range shown and the offset to continue from. Use this instead of cat, head, tail, or sed. " +
		"Binary files are rejected.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const { absolute, display: displayPath } = resolveToolPath(workspace, sandbox, args.path, "read");

		let buffer: Buffer;
		try {
			const stats = statSync(absolute);
			if (stats.isDirectory()) {
				return { content: `${displayPath} is a directory, not a file. Pass the path of a file.`, isError: true };
			}
			buffer = readFileSync(absolute);
		} catch (error) {
			return { content: `Failed to read ${displayPath}: ${describeError(error)}`, isError: true };
		}

		if (looksBinary(buffer, BINARY_PROBE_BYTES)) {
			return { content: `${displayPath} looks like a binary file and cannot be read as text`, isError: true };
		}

		const file: TextFile = decodeTextFile(buffer);
		const lines = splitLines(file.text);
		if (lines.length === 0) {
			return { content: `${displayPath} is empty`, details: { path: displayPath, lines: 0 } };
		}

		const startIndex = (args.offset ?? 1) - 1;
		if (startIndex >= lines.length) {
			return {
				content: `${displayPath} has ${lines.length} lines; offset=${args.offset} is out of range`,
				isError: true,
			};
		}
		const available = args.limit === undefined ? lines.length - startIndex : args.limit;
		const truncated = truncateHead(lines.slice(startIndex, startIndex + available).join("\n"), DEFAULT_LIMITS);
		const keptLines = splitLines(truncated.text);
		const firstLine = startIndex + 1;
		const lastLine = startIndex + keptLines.length;

		const parts = [truncated.text];
		if (file.encoding !== "utf8") parts.push(`[file encoding: ${file.encoding}]`);
		if (lastLine < lines.length) {
			parts.push(`[showing lines ${firstLine}-${lastLine} of ${lines.length}; continue with offset=${lastLine + 1}]`);
		}

			return {
				content: parts.join("\n\n"),
				details: {
					path: displayPath,
					startLine: firstLine,
					endLine: lastLine,
					totalLines: lines.length,
					encoding: file.encoding,
					// 界面展开用完整正文；result 可能被落盘成预览，不能拿它排版
					text: truncated.text,
				},
			};
	},
};

