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
		path: { type: "string", description: "文件路径，相对工作根或绝对路径" },
		content: { type: "string", description: "完整文件内容；要改已有文件请用 edit" },
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
		"写入文件，父目录会自动创建。内容较长时整段覆盖会丢掉原有改动，" +
		"所以修改已有文件请改用 edit。",
	parameters: PARAMETERS,
	annotations: { readOnly: false, destructive: true, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path);
		sandbox.assertPathAllowed("write", resolved.absolute);
		const displayPath = workspace.display(resolved.absolute);
		const bytes = Buffer.byteLength(args.content, "utf8");

		return withFileMutation(resolved.absolute, async (): Promise<ToolResult> => {
			if (existsSync(resolved.absolute) && statSync(resolved.absolute).isDirectory()) {
				return { content: `${displayPath} 是一个目录，不能写入`, isError: true };
			}

			const existed = existsSync(resolved.absolute);
			const previousBytes = existed ? statSync(resolved.absolute).size : 0;

			try {
				mkdirSync(dirname(resolved.absolute), { recursive: true });
				writeFileSync(resolved.absolute, args.content, "utf8");
			} catch (error) {
				return { content: `写入 ${displayPath} 失败：${describeError(error)}`, isError: true };
			}

			const summary = existed
				? `已覆盖 ${displayPath}，写入 ${bytes} 字节（原有 ${previousBytes} 字节）`
				: `已创建 ${displayPath}，写入 ${bytes} 字节`;
			return { content: summary, details: { path: displayPath, bytes, created: !existed } };
		});
	},
};

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
