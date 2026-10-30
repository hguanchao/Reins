import { readFileSync, statSync } from "node:fs";

import { resolveToolPath } from "#src/tools/path.ts";
import { describeError } from "#src/shared/describe-error.ts";
import type { ToolDefinition, ToolResult } from "#src/tools/contract.ts";
import type { JsonSchema } from "#src/tools/schema.ts";
import { DEFAULT_LIMITS, splitLines, truncateHead } from "#src/tools/truncate.ts";
import { BINARY_PROBE_BYTES, decodeTextFile, looksBinary, type TextFile } from "#src/tools/text-file.ts";

/**
 * 读取文件。
 *
 * 输出按行给出并带行号区间，截断只发生在行边界上：模型据此决定要不要接着读，而半行会让它
 * 误以为内容到此为止。
 */

/** 截断尾注的固定前缀:界面摘要靠它识别「这条结果只给了一部分」并提取行区间。 */
const READ_FOOTER_PREFIX = "[showing lines ";

/** 单次读取的文件大小上限：超过就拒绝，避免整份读入内存把事件循环卡住。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * 解析截断尾注里的行区间;不是截断结果时返回 undefined。
 * 文案由本工具产出,消费方用同一个前缀解析:改文案只改这里。
 */
export function readFooterRange(content: string):
	| { readonly start: number; readonly end: number; readonly total: number }
	| undefined {
	const match = /\[showing lines (\d+)-(\d+) of (\d+);/.exec(content);
	if (match === null) return undefined;
	return {
		start: Number(match[1]),
		end: Number(match[2]),
		total: Number(match[3]),
	};
}

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
		`Read a text file and return its content. A call returns at most ` +
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
			// 只有普通文件才读：FIFO、设备文件会让 readFileSync 永久阻塞。
			if (!stats.isFile()) {
				return { content: `${displayPath} is not a regular file and cannot be read`, isError: true };
			}
			// 超过上限就不整份读入：同步读取会阻塞事件循环，TUI 会整屏卡住。
			if (stats.size > MAX_FILE_BYTES) {
				return {
					content:
						`${displayPath} is ${stats.size} bytes, larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB ` +
						"read limit. Use grep to find the part you need, or read it in slices with a command.",
					isError: true,
				};
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
		const window = lines.slice(startIndex, startIndex + available);
		const truncated = truncateHead(window.join("\n"), DEFAULT_LIMITS);
		// 行号要按窗口算，不能按截断结果的行数算：窗口里全是空行时 truncateHead 返回空文本，
		// splitLines 得到 0 行，续读 offset 会与本次相同，模型于是反复重试同一个窗口。
		const keptLines = truncated.text.length === 0 ? window.length : splitLines(truncated.text).length;
		const firstLine = startIndex + 1;
		const lastLine = startIndex + Math.max(keptLines, 1);
		const windowEnd = startIndex + window.length;
		const hasMore = windowEnd < lines.length;

		// 窗口里全是空行时正文只是一串换行：补一句说明，否则模型看到空白会以为读失败了
		const blankWindow = window.every((line) => line.trim().length === 0);
		const body = blankWindow
			? `[lines ${firstLine}-${windowEnd} are blank]`
			: truncated.text.length > 0
				? truncated.text
				: `[lines ${firstLine}-${lastLine} are blank]`;
		const parts = [body];
		if (file.encoding !== "utf8") parts.push(`[file encoding: ${file.encoding}]`);
		if (file.lossy) {
			parts.push(
				"[file is not valid UTF-8; it was decoded with replacement characters. Do not overwrite it in place.]",
			);
		}
		// 两种「还有内容」都要报：窗口后面还有行，或这一行本身被字节上限截断
		if (hasMore) {
			parts.push(
				`${READ_FOOTER_PREFIX}${firstLine}-${lastLine} of ${lines.length}; continue with offset=${windowEnd + 1}]`,
			);
		} else if (truncated.truncated) {
			parts.push(
				`[line ${firstLine} was truncated at ${DEFAULT_LIMITS.maxBytes / 1024} KB; ` +
					`the file has ${lines.length} lines in total]`,
			);
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

