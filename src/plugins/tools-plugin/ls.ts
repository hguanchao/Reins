import { readdirSync, statSync } from "node:fs";

import type { ToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { JsonSchema } from "../../tools/schema.ts";

/** 列出一层目录的内容。 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "目录路径，省略则列工作根" },
		limit: { type: "integer", minimum: 1, description: "最多列出多少项，默认 500" },
	},
	required: [],
} as const satisfies JsonSchema;

type LsArgs = {
	readonly path?: string;
	readonly limit?: number;
};

const DEFAULT_LIMIT = 500;

export const lsTool: ToolDefinition<LsArgs> = {
	name: "ls",
	description: "列出目录内容。目录名带斜杠结尾，不递归。",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path ?? ".");
		sandbox.assertPathAllowed("read", resolved.absolute);
		const displayPath = workspace.display(resolved.absolute);
		const limit = args.limit ?? DEFAULT_LIMIT;

		let names: readonly string[];
		try {
			if (!statSync(resolved.absolute).isDirectory()) {
				return { content: `${displayPath} 不是目录`, isError: true };
			}
			names = readdirSync(resolved.absolute).sort((left, right) =>
				left.toLowerCase().localeCompare(right.toLowerCase()),
			);
		} catch (error) {
			return { content: `列出 ${displayPath} 失败：${describeError(error)}`, isError: true };
		}

		if (names.length === 0) return { content: `${displayPath} 是空目录` };

		const shown: string[] = [];
		for (const name of names.slice(0, limit)) {
			const isDirectory = safeIsDirectory(`${resolved.absolute}/${name}`);
			shown.push(isDirectory ? `${name}/` : name);
		}
		if (names.length > shown.length) {
			shown.push(`…（共 ${names.length} 项，只列出前 ${shown.length} 项）`);
		}

		return {
			content: shown.join("\n"),
			details: { path: displayPath, total: names.length, shown: shown.length },
		};
	},
};

function safeIsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
