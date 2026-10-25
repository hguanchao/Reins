import { resolveToolPath } from "../../tools/path.ts";
import type { ToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { JsonSchema } from "../../tools/schema.ts";
import { fileEntries, globToRegExp, MAX_WALK_ENTRIES } from "../../workspace/walk.ts";

/** 按通配模式查找文件路径。 */

const PARAMETERS = {
	type: "object",
	properties: {
		pattern: {
			type: "string",
			description: "Path glob, e.g. src/**/*.ts. ** crosses directories; * and ? stay within one segment.",
		},
		path: { type: "string", description: "Directory to search; defaults to the workspace root." },
		limit: { type: "integer", minimum: 1, description: "Maximum paths to return; defaults to 1000." },
	},
	required: ["pattern"],
} as const satisfies JsonSchema;

type FindArgs = {
	readonly pattern: string;
	readonly path?: string;
	readonly limit?: number;
};

const DEFAULT_LIMIT = 1000;

export const findTool: ToolDefinition<FindArgs> = {
	name: "find",
	summary: "Find files by glob pattern",
	description:
		"Find files whose path matches a glob and return paths relative to the workspace root. ** crosses " +
		"directories; * and ? match within one path segment. Starts from path (default: workspace root), skips " +
		".git and node_modules, and stops at the limit.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const { absolute } = resolveToolPath(workspace, sandbox, args.path ?? ".", "read");
		const limit = args.limit ?? DEFAULT_LIMIT;
		// 模式里的正则元字符都会被转义，所以这里不存在编译失败的情形
		const matcher = globToRegExp(args.pattern);

		const matched: string[] = [];
		let scanned = 0;
		for (const entry of fileEntries(absolute, MAX_WALK_ENTRIES)) {
			scanned += 1;
			// 同时用相对工作根与相对起点两种路径去匹配，写 src/**/*.ts 与 **/*.ts 都能用
			const displayPath = workspace.display(entry.absolute);
			if (matcher.test(entry.relative) || matcher.test(displayPath)) {
				// 输出统一相对工作根：模型拿到的路径要能直接交给 read/edit
				matched.push(displayPath);
				if (matched.length >= limit) break;
			}
		}

		if (matched.length === 0) {
			return { content: `No files match ${args.pattern} (${scanned} files checked)` };
		}

		const parts = [matched.join("\n")];
		if (matched.length >= limit) parts.push(`[hit the limit of ${limit}; there may be more]`);
		return { content: parts.join("\n\n"), details: { pattern: args.pattern, matched: matched.length } };
	},
};
