import { readFileSync } from "node:fs";

import type { ToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { JsonSchema } from "../../tools/schema.ts";
import { looksBinary } from "../../tools/builtin/text-file.ts";
import { MAX_LINE_LENGTH, truncateLine } from "../../tools/truncate.ts";
import { globToRegExp, walk } from "./walk.ts";

/**
 * 按内容检索。
 *
 * 自己逐行扫，不依赖外部检索工具：这样在任何环境里都可用，不必先装什么，也不必在缺失时
 * 退回另一套行为。代价是在超大目录树上比专门的工具慢——需要那种速度时，把它作为插件替换掉
 * 即可，这正是它被放在插件里的原因。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		pattern: { type: "string", description: "要匹配的内容，默认按正则解释" },
		path: { type: "string", description: "在哪个目录下找，省略则从工作根开始" },
		glob: { type: "string", description: "只在这些文件里找，如 **/*.ts" },
		literal: { type: "boolean", description: "为 true 时把 pattern 当作普通文本" },
		ignoreCase: { type: "boolean", description: "忽略大小写" },
		limit: { type: "integer", minimum: 1, description: "最多返回多少条匹配，默认 100" },
	},
	required: ["pattern"],
} as const satisfies JsonSchema;

type GrepArgs = {
	readonly pattern: string;
	readonly path?: string;
	readonly glob?: string;
	readonly literal?: boolean;
	readonly ignoreCase?: boolean;
	readonly limit?: number;
};

const DEFAULT_LIMIT = 100;
/** 单个文件的大小上限。更大的多半是生成物或数据，扫它只是白花时间。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 判断内容的探查范围。 */
const BINARY_PROBE_BYTES = 8192;

export const grepTool: ToolDefinition<GrepArgs> = {
	name: "grep",
	description:
		"在文件内容里检索，返回「相对路径:行号: 该行内容」。默认按正则解释 pattern，" +
		"literal 为真时按普通文本。跳过 .git 与 node_modules。",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path ?? ".");
		sandbox.assertPathAllowed("read", resolved.absolute);
		const limit = args.limit ?? DEFAULT_LIMIT;

		let matcher: RegExp;
		try {
			const source = args.literal === true ? escapeRegExp(args.pattern) : args.pattern;
			matcher = new RegExp(source, args.ignoreCase === true ? "i" : "");
		} catch (error) {
			return { content: `pattern 不是合法的正则：${describeError(error)}`, isError: true };
		}

		const fileMatcher = args.glob === undefined ? undefined : globToRegExp(args.glob);
		const matches: string[] = [];
		let scannedFiles = 0;

		for (const entry of walk(resolved.absolute, { maxEntries: Number.MAX_SAFE_INTEGER })) {
			if (entry.kind !== "file") continue;
			const relativePath = workspace.display(entry.absolute);
			if (fileMatcher !== undefined && !fileMatcher.test(entry.relative) && !fileMatcher.test(relativePath)) {
				continue;
			}

			scannedFiles += 1;
			const text = readTextOrSkip(entry.absolute);
			if (text === undefined) continue;

			const lines = text.split("\n");
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				if (!matcher.test(line)) continue;
				matches.push(`${relativePath}:${index + 1}: ${truncateLine(line, MAX_LINE_LENGTH)}`);
				if (matches.length >= limit) break;
			}
			if (matches.length >= limit) break;
		}

		if (matches.length === 0) {
			return { content: `没有匹配「${args.pattern}」的内容（已检查 ${scannedFiles} 个文件）` };
		}

		const parts = [matches.join("\n")];
		if (matches.length >= limit) parts.push(`[已达到 ${limit} 条上限，可用 glob 缩小范围或提高 limit]`);
		return { content: parts.join("\n\n"), details: { pattern: args.pattern, matched: matches.length } };
	},
};

/** 读文本；二进制或过大的文件跳过，返回 undefined。 */
function readTextOrSkip(path: string): string | undefined {
	try {
		const buffer = readFileSync(path);
		if (buffer.length > MAX_FILE_BYTES) return undefined;
		if (looksBinary(buffer, BINARY_PROBE_BYTES)) return undefined;
		return buffer.toString("utf8");
	} catch {
		return undefined;
	}
}

function escapeRegExp(text: string): string {
	return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
