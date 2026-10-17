import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname } from "node:path";

import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { withFileMutation } from "./file-mutation-queue.ts";

/** 创建或覆盖文件。父目录不存在时一并建出来，省掉一次单独的建目录往返。 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "The path to write, relative to the workspace root or absolute." },
		content: { type: "string", description: "The complete file content. To modify an existing file, use edit instead." },
	},
	required: ["path", "content"],
} as const satisfies JsonSchema;

type WriteArgs = {
	readonly path: string;
	readonly content: string;
};

export const writeTool: ToolDefinition<WriteArgs> = {
	name: "write",
	description:
		"Write a file; missing parent directories are created. Overwriting a whole file discards the existing content, " +
		"so use edit to modify an existing file.",
	parameters: PARAMETERS,
	annotations: { readOnly: false, destructive: true, openWorld: false },

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

			try {
				mkdirSync(dirname(resolved.absolute), { recursive: true });
				writeFileSync(resolved.absolute, args.content, "utf8");
			} catch (error) {
				return { content: `Failed to write ${displayPath}: ${describeError(error)}`, isError: true };
			}

			const summary = existed
				? `Overwrote ${displayPath} with ${bytes} bytes (was ${previousBytes} bytes)`
				: `Created ${displayPath} with ${bytes} bytes`;
			return { content: summary, details: { path: displayPath, bytes, created: !existed } };
		});
	},
};

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
