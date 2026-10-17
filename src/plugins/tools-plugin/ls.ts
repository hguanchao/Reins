import { readdirSync, statSync } from "node:fs";

import type { ToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { JsonSchema } from "../../tools/schema.ts";

/** 列出一层目录的内容。 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "Directory to list; defaults to the workspace root" },
		limit: { type: "integer", minimum: 1, description: "Maximum entries to list; defaults to 500" },
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
	description: "List a directory. Directory names end with a slash; not recursive.",
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
				return { content: `${displayPath} is not a directory`, isError: true };
			}
			names = readdirSync(resolved.absolute).sort((left, right) =>
				left.toLowerCase().localeCompare(right.toLowerCase()),
			);
		} catch (error) {
			return { content: `Cannot list ${displayPath}: ${describeError(error)}`, isError: true };
		}

		if (names.length === 0) return { content: `${displayPath} is empty` };

		const shown: string[] = [];
		for (const name of names.slice(0, limit)) {
			const isDirectory = safeIsDirectory(`${resolved.absolute}/${name}`);
			shown.push(isDirectory ? `${name}/` : name);
		}
		if (names.length > shown.length) {
			shown.push(`… (${names.length} entries; showing the first ${shown.length})`);
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
