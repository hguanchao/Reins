import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname } from "node:path";

import { resolveToolPath, writeScope } from "../path.ts";
import { describeError } from "../../shared/describe-error.ts";
import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { formatEditDiff } from "./diff.ts";
import { withFileMutation } from "./mutation-queue.ts";
import { BINARY_PROBE_BYTES, decodeTextFile, encodeTextFile, looksBinary } from "../text-file.ts";

/** 创建或覆盖文件。父目录不存在时一并建出来，省掉一次单独的建目录往返。 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path, relative to the workspace root or absolute." },
		content: { type: "string", description: "Complete file content. To modify an existing file, use edit instead." },
	},
	required: ["path", "content"],
} as const satisfies JsonSchema;

type WriteArgs = {
	readonly path: string;
	readonly content: string;
};

/** 只给大小可控的文本生成 diff；整文件覆盖的 diff 不值得为超大文件付出代价。 */
const MAX_DIFF_BYTES = 256 * 1024;
export const writeTool: ToolDefinition<WriteArgs> = {
	name: "write",
	summary: "Create or fully overwrite a file; parent directories are created",
	description:
		"Create a file or replace its entire content; missing parent directories are created. Use edit instead to " +
		"change an existing file, because a full overwrite discards content you have not read.",
	parameters: PARAMETERS,
	annotations: { readOnly: false, destructive: true, openWorld: false },

	permissionScope: (args, workspace) => writeScope(workspace, args.path),

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const { absolute, display: displayPath } = resolveToolPath(workspace, sandbox, args.path, "write");
		const bytes = Buffer.byteLength(args.content, "utf8");

		return withFileMutation(absolute, async (): Promise<ToolResult> => {
			if (existsSync(absolute) && statSync(absolute).isDirectory()) {
				return { content: `${displayPath} is a directory and cannot be written`, isError: true };
			}

			const existed = existsSync(absolute);
			const previousBytes = existed ? statSync(absolute).size : 0;
			let previous: string | undefined;
			// 已有文件按它自己的编码与行尾写回：直接按 UTF-8 覆盖会让 CRLF 文件整体变成 LF、
			// 丢掉 BOM，或把 UTF-16 文件换成 UTF-8——使用者只改内容，不该连带改编码。
			let existing: ReturnType<typeof decodeTextFile> | undefined;
			if (existed && previousBytes <= MAX_DIFF_BYTES) {
				try {
					const buffer = readFileSync(absolute);
					if (!looksBinary(buffer, BINARY_PROBE_BYTES)) {
						existing = decodeTextFile(buffer);
						previous = existing.text;
					}
				} catch {
					// 读不到旧内容不影响写入，只是这次没有 diff 可展示
					previous = undefined;
				}
			}
			if (!existed) previous = bytes <= MAX_DIFF_BYTES ? "" : undefined;

			if (existing?.lossy === true) {
				return {
					content:
						`${displayPath} is not valid UTF-8, so overwriting it would corrupt the file. ` +
						"Convert it to UTF-8 first, or change it with a tool that preserves the original encoding.",
					isError: true,
				};
			}

			try {
				mkdirSync(dirname(absolute), { recursive: true });
				writeFileSync(
					absolute,
					existing === undefined ? args.content : encodeTextFile(existing, args.content),
				);
			} catch (error) {
				return { content: `Failed to write ${displayPath}: ${describeError(error)}`, isError: true };
			}

			const summary = existed
				? `Overwrote ${displayPath} with ${bytes} bytes (was ${previousBytes} bytes)`
				: `Created ${displayPath} with ${bytes} bytes`;
			const diff =
				previous === undefined
					? undefined
					: formatEditDiff(previous, args.content, [
							{ start: 0, end: previous.length, newText: args.content },
						]);
			return {
				content: summary,
				details: {
					path: displayPath,
					bytes,
					created: !existed,
					...(diff === undefined ? {} : { diff }),
				},
			};
		});
	},
};

