import { readFileSync, statSync } from "node:fs";

import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { DEFAULT_LIMITS, splitLines, truncateHead } from "../truncate.ts";
import { decodeTextFile, looksBinary, type TextFile } from "./text-file.ts";

/**
 * 读取文件。
 *
 * 输出按行给出并带行号区间，截断只发生在行边界上：模型据此决定要不要接着读，而半行会让它
 * 误以为内容到此为止。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "文件路径，相对工作根或绝对路径" },
		offset: { type: "integer", minimum: 1, description: "从第几行开始读，行号从 1 计数" },
		limit: { type: "integer", minimum: 1, description: "最多读多少行" },
	},
	required: ["path"],
} as const satisfies JsonSchema;

type ReadArgs = {
	readonly path: string;
	readonly offset?: number;
	readonly limit?: number;
};

/** 判断内容的探查范围。 */
const BINARY_PROBE_BYTES = 8192;

export const readTool: ToolDefinition<ReadArgs> = {
	name: "read",
	description:
		"读取一个文本文件。返回内容带行号区间；一次最多返回 2000 行或 50 KB，" +
		"内容更长时用 offset 接着读。行号从 1 开始。",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path);
		sandbox.assertPathAllowed("read", resolved.absolute);
		const displayPath = workspace.display(resolved.absolute);

		let buffer: Buffer;
		try {
			const stats = statSync(resolved.absolute);
			if (stats.isDirectory()) {
				return { content: `${displayPath} 是一个目录，不是文件`, isError: true };
			}
			buffer = readFileSync(resolved.absolute);
		} catch (error) {
			return { content: `读取 ${displayPath} 失败：${describeError(error)}`, isError: true };
		}

		if (looksBinary(buffer, BINARY_PROBE_BYTES)) {
			return { content: `${displayPath} 看起来是二进制文件，无法按文本读取`, isError: true };
		}

		const file: TextFile = decodeTextFile(buffer);
		const lines = splitLines(file.text);
		if (lines.length === 0) {
			return { content: `${displayPath} 是空文件`, details: { path: displayPath, lines: 0 } };
		}

		const startIndex = (args.offset ?? 1) - 1;
		if (startIndex >= lines.length) {
			return {
				content: `${displayPath} 只有 ${lines.length} 行，offset=${args.offset} 超出了范围`,
				isError: true,
			};
		}
		const available = args.limit === undefined ? lines.length - startIndex : args.limit;
		const truncated = truncateHead(lines.slice(startIndex, startIndex + available).join("\n"), DEFAULT_LIMITS);
		const keptLines = splitLines(truncated.text);
		const firstLine = startIndex + 1;
		const lastLine = startIndex + keptLines.length;

		const parts = [truncated.text];
		if (file.encoding !== "utf8") parts.push(`[文件编码为 ${file.encoding}]`);
		if (lastLine < lines.length) {
			parts.push(`[显示第 ${firstLine}-${lastLine} 行，共 ${lines.length} 行；用 offset=${lastLine + 1} 继续]`);
		}

		return {
			content: parts.join("\n\n"),
			details: {
				path: displayPath,
				startLine: firstLine,
				endLine: lastLine,
				totalLines: lines.length,
				encoding: file.encoding,
			},
		};
	},
};

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
