import type { ToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { JsonSchema } from "../../tools/schema.ts";
import { globToRegExp, walk } from "./walk.ts";

/** 按通配模式查找文件路径。 */

const PARAMETERS = {
	type: "object",
	properties: {
		pattern: { type: "string", description: "路径通配模式，如 src/**/*.ts；** 跨目录，* 不跨目录" },
		path: { type: "string", description: "在哪个目录下找，省略则从工作根开始" },
		limit: { type: "integer", minimum: 1, description: "最多返回多少条，默认 1000" },
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
	description:
		"按路径名查找文件，返回相对路径。`**` 跨目录、`*` 与 `?` 只在单层内匹配。" +
		"跳过 .git 与 node_modules。",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path ?? ".");
		sandbox.assertPathAllowed("read", resolved.absolute);
		const limit = args.limit ?? DEFAULT_LIMIT;
		// 模式里的正则元字符都会被转义，所以这里不存在编译失败的情形
		const matcher = globToRegExp(args.pattern);

		const matched: string[] = [];
		let scanned = 0;
		for (const entry of walk(resolved.absolute, { maxEntries: Number.MAX_SAFE_INTEGER })) {
			if (entry.kind !== "file") continue;
			scanned += 1;
			// 同时用相对工作根与相对起点两种路径去匹配，写 src/**/*.ts 与 **/*.ts 都能用
			if (matcher.test(entry.relative) || matcher.test(workspace.display(entry.absolute))) {
				matched.push(entry.relative);
				if (matched.length >= limit) break;
			}
		}

		if (matched.length === 0) {
			return { content: `没有匹配 ${args.pattern} 的文件（已检查 ${scanned} 个文件）` };
		}

		const parts = [matched.join("\n")];
		if (matched.length >= limit) parts.push(`[已达到 ${limit} 条上限，可能有更多]`);
		return { content: parts.join("\n\n"), details: { pattern: args.pattern, matched: matched.length } };
	},
};

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
