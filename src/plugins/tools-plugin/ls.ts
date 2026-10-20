import { readdirSync, statSync } from "node:fs";

import type { ToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { JsonSchema } from "../../tools/schema.ts";
import { walk, type WalkEntry } from "./walk.ts";

/**
 * 列出一棵目录树。
 *
 * 只列一层时，模型要摸清一个仓库的结构就得反复调用；一次递归列出又可能把上下文灌满。
 * 这里按字符预算展开：小目录直接展开，大子树折叠成文件数与扩展名汇总，和搜索结果里的
 * 过滤口径保持一致——跳过 .git 与 node_modules，不跟随符号链接。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		path: { type: "string", description: "Directory to list; defaults to the workspace root." },
		limit: {
			type: "integer",
			minimum: 1,
			description: "Maximum entries to walk; defaults to 1000.",
		},
	},
	required: [],
} as const satisfies JsonSchema;

type LsArgs = {
	readonly path?: string;
	readonly limit?: number;
};

const DEFAULT_LIMIT = 1000;
/** 同步遍历的硬上限；参数再大也不能让界面卡在目录树上。 */
const MAX_LIMIT = 10_000;
/** 一次列出的字符上限；超出后优先保留根层条目，子树收敛成汇总行。 */
const MAX_OUTPUT_CHARS = 10_000;
const TOP_EXTENSIONS = 3;

interface TreeNode {
	readonly name: string;
	readonly depth: number;
	readonly directory: boolean;
	readonly children: Map<string, TreeNode>;
	/** 整棵子树里的文件数，用于折叠摘要 */
	fileCount: number;
	/** 整棵子树里的扩展名计数 */
	readonly byExt: Map<string, number>;
	/** 预算允许时展开；根节点始终展开 */
	expanded: boolean;
}

export const lsTool: ToolDefinition<LsArgs> = {
	name: "ls",
	summary: "List a directory tree, summarizing large subtrees",
	description:
		"List files and directories recursively from path (default: workspace root). Small directories are " +
		"expanded; large subtrees are summarized with file counts and extension breakdowns. Skips .git and " +
		"node_modules and does not follow symlinks. Stops after limit entries.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args, workspace, sandbox }): Promise<ToolResult> {
		const resolved = workspace.resolve(args.path ?? ".");
		sandbox.assertPathAllowed("read", resolved.absolute);
		const displayPath = workspace.display(resolved.absolute);

		try {
			if (!statSync(resolved.absolute).isDirectory()) {
				return { content: `${displayPath} is not a directory`, isError: true };
			}
			// walk 会静默跳过读不了的目录；根目录读不了时必须明确报错，不能假装它是空的
			readdirSync(resolved.absolute);
		} catch (error) {
			return { content: `Cannot list ${displayPath}: ${describeError(error)}`, isError: true };
		}

		const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
		const entries: WalkEntry[] = [];
		let truncated = false;
		for (const entry of walk(resolved.absolute, { maxEntries: limit + 1 })) {
			if (entries.length >= limit) {
				truncated = true;
				break;
			}
			entries.push(entry);
		}

		const root = createNode(displayPath, 0, true);
		for (const entry of entries) insertEntry(root, entry);

		return {
			content: renderTree(root, displayPath, truncated),
			details: { path: displayPath, total: root.children.size, shown: entries.length, truncated },
		};
	},
};

function createNode(name: string, depth: number, directory: boolean): TreeNode {
	return {
		name,
		depth,
		directory,
		children: new Map(),
		fileCount: 0,
		byExt: new Map(),
		expanded: false,
	};
}

function ensureChild(parent: TreeNode, name: string, directory: boolean): TreeNode {
	let child = parent.children.get(name);
	if (child === undefined) {
		child = createNode(name, parent.depth + 1, directory);
		parent.children.set(name, child);
	}
	return child;
}

/** 把一条遍历结果挂进树；文件同时给路径上的每一层目录累计文件数。 */
function insertEntry(root: TreeNode, entry: WalkEntry): void {
	const parts = entry.relative.split("/").filter((part) => part.length > 0);
	const leaf = parts.at(-1);
	if (leaf === undefined) return;

	if (entry.kind === "directory") {
		let node = root;
		for (const part of parts) node = ensureChild(node, part, true);
		return;
	}

	const extension = extensionOf(leaf);
	root.fileCount += 1;
	addExtension(root, extension);

	let node = root;
	for (const part of parts.slice(0, -1)) {
		node = ensureChild(node, part, true);
		node.fileCount += 1;
		addExtension(node, extension);
	}
	ensureChild(node, leaf, false);
}

function addExtension(node: TreeNode, extension: string): void {
	node.byExt.set(extension, (node.byExt.get(extension) ?? 0) + 1);
}

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	if (index <= 0 || index === name.length - 1) return "no-ext";
	return name.slice(index + 1).toLowerCase();
}

function sortedChildren(node: TreeNode): readonly TreeNode[] {
	return [...node.children.values()].sort((left, right) => {
		const a = left.name.toLowerCase();
		const b = right.name.toLowerCase();
		if (a < b) return -1;
		if (a > b) return 1;
		return left.name.localeCompare(right.name);
	});
}

function indent(depth: number): string {
	return "  ".repeat(depth);
}

/** 折叠子树的摘要：`[977 files in subtree: 976 *.txt, 1 *.csv]`。 */
function summary(node: TreeNode): string {
	if (node.fileCount === 0 || node.byExt.size === 0) return "";

	const items = [...node.byExt.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
	const top = items.slice(0, TOP_EXTENSIONS);
	const covered = top.reduce((total, [, count]) => total + count, 0);
	const parts = top.map(([extension, count]) =>
		extension === "no-ext" ? `${count} *no-ext` : `${count} *.${extension}`,
	);
	const more = covered < node.fileCount ? ", ..." : "";
	const word = node.fileCount === 1 ? "file" : "files";
	return `[${node.fileCount} ${word} in subtree: ${parts.join(", ")}${more}]`;
}

function summaryCost(node: TreeNode): number {
	const line = summary(node);
	if (line.length === 0) return 0;
	return indent(node.depth + 1).length + line.length + 1;
}

/** 按当前 expanded 标记渲染子树；未展开的目录用摘要行代替子项。 */
function renderChildren(node: TreeNode): string {
	let output = "";
	for (const child of sortedChildren(node)) {
		output += `${indent(child.depth)}- ${child.name}${child.directory ? "/" : ""}\n`;
		if (!child.directory) continue;
		if (child.expanded) {
			output += renderChildren(child);
			continue;
		}
		const line = summary(child);
		if (line.length > 0) output += `${indent(child.depth + 1)}${line}\n`;
	}
	return output;
}

function renderTree(root: TreeNode, displayPath: string, truncated: boolean): string {
	const rootLabel = displayPath.endsWith("/") ? displayPath : `${displayPath}/`;
	const rootLine = `- ${rootLabel}`;
	const cutoff = truncated ? "\n[listing stopped after the entry limit; narrow the path or raise limit]" : "";

	if (root.children.size === 0) return `${rootLine}\n  (empty)${cutoff}`;

	root.expanded = true;
	const rootChildren = renderChildren(root);
	if (rootLine.length + 1 + rootChildren.length > MAX_OUTPUT_CHARS) {
		return `${renderTruncatedRoot(rootLine, root)}${cutoff}`;
	}

	let remaining = MAX_OUTPUT_CHARS - rootLine.length - 1 - rootChildren.length;
	const queue: TreeNode[] = sortedChildren(root).filter((child) => child.directory);
	while (queue.length > 0) {
		const node = queue.shift() as TreeNode;
		const expanded = renderChildren(node);
		const cost = summaryCost(node);
		if (expanded.length > remaining + cost) continue;

		node.expanded = true;
		remaining += cost;
		remaining -= expanded.length;
		for (const child of sortedChildren(node)) {
			if (child.directory) queue.push(child);
		}
	}

	return `${rootLine}\n${renderChildren(root)}${cutoff}`;
}

/** 根层本身就放不下时，能列多少列多少，再给一条收窄路径的提示。 */
function renderTruncatedRoot(rootLine: string, root: TreeNode): string {
	let output = `${rootLine}\n`;
	for (const child of sortedChildren(root)) {
		let chunk = `${indent(child.depth)}- ${child.name}${child.directory ? "/" : ""}\n`;
		if (child.directory) {
			const line = summary(child);
			if (line.length > 0) chunk += `${indent(child.depth + 1)}${line}\n`;
		}
		if (output.length + chunk.length > MAX_OUTPUT_CHARS) break;
		output += chunk;
	}
	return `${output}    ...\n\nNote: this directory is too large to list fully; list a narrower path.\n`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
