import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname } from "node:path";

import { describeError } from "../../describe-error.ts";
import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { formatEditDiff } from "./edit-diff.ts";
import { withFileMutation } from "./file-mutation-queue.ts";
import { BINARY_PROBE_BYTES, decodeTextFile, looksBinary } from "./text-file.ts";

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

	/** 本会话内按具体文件路径记住 */
	permissionScope(args, workspace) {
		const resolved = workspace.resolve(args.path);
		const label = workspace.display(resolved.absolute);
		return { key: resolved.absolute, label, short: label };
	},

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path);
		sandbox.assertPathAllowed("write", resolved.absolute);
		const displayPath = workspace.display(resolved.absolute);
		const bytes = Buffer.byteLength(args.content, "utf8");

		return withFileMutation(resolved.absolute, async (): Promise<ToolResult> => {
			if (existsSync(resolved.absolute) && statSync(resolved.absolute).isDirectory()) {
				return { content: `${displayPath} is a directory and cannot be written`, isError: true };
			}

			const existed = existsSync(resolved.absolute);
			const previousBytes = existed ? statSync(resolved.absolute).size : 0;
			let previous: string | undefined;
			if (!existed && bytes <= MAX_DIFF_BYTES) {
				previous = "";
			} else if (existed && previousBytes <= MAX_DIFF_BYTES) {
				try {
					const buffer = readFileSync(resolved.absolute);
					if (!looksBinary(buffer, BINARY_PROBE_BYTES)) previous = decodeTextFile(buffer).text;
				} catch {
					// 读不到旧内容不影响写入，只是这次没有 diff 可展示
					previous = undefined;
				}
			}

			try {
				mkdirSync(dirname(resolved.absolute), { recursive: true });
				writeFileSync(resolved.absolute, args.content, "utf8");
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

