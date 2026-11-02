import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

import { BINARY_PROBE_BYTES, decodeTextFile, looksBinary } from "#src/tools/text-file.ts";
import { isPathInside, resolveRealPath, type WorkspaceBoundary } from "#src/workspace/boundary.ts";
import { fileEntries, listDirectory } from "#src/workspace/walk.ts";

/**
 * 浏览器界面的只读文件访问。
 *
 * 文件树、代码查看与 @ 提及都走这里：路径一律先过工作区边界，再按真实路径复核一次，
 * 软链接不能把读取带出工作区。只读，不提供写入。
 */

/** 单个文件最多读这么多字节；再大的文件在界面上也读不完，截断后明确标注。 */
export const MAX_FILE_BYTES = 512 * 1024;

/** 文件搜索最多扫这么多条，避免一次提及补全把整个大仓库读一遍。 */
const MAX_SEARCH_ENTRIES = 20_000;

export interface FileTreeEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: "file" | "directory";
}

export interface FileTree {
	readonly path: string;
	readonly entries: readonly FileTreeEntry[];
}

export interface FileContent {
	readonly path: string;
	readonly text: string;
	readonly encoding: string;
	readonly hasBom: boolean;
	readonly lossy: boolean;
	readonly binary: boolean;
	readonly truncated: boolean;
	readonly size: number;
}

export interface FileSearchHit {
	readonly path: string;
	readonly kind: "file" | "directory";
}

/** 列出工作区里的一层目录。 */
export function fileTree(workspace: WorkspaceBoundary, input: string): FileTree {
	const real = resolveInside(workspace, input);
	const stats = statSync(real);
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${input}`);

	const path = workspace.display(real);
	const entries = listDirectory(workspace.root, path === "." ? "" : path);
	return {
		path,
		entries: entries.map((entry) => ({
			name: basename(entry.relative),
			path: entry.relative,
			kind: entry.kind,
		})),
	};
}

/** 读取一个文本文件；二进制文件只回报类型，不返回内容。 */
export function readWorkspaceFile(workspace: WorkspaceBoundary, input: string): FileContent {
	const real = resolveInside(workspace, input);
	const stats = statSync(real);
	if (!stats.isFile()) throw new Error(`Not a file: ${input}`);

	const truncated = stats.size > MAX_FILE_BYTES;
	const buffer = readPrefix(real, MAX_FILE_BYTES + 1);
	const path = workspace.display(real);
	if (looksBinary(buffer, BINARY_PROBE_BYTES)) {
		return {
			path,
			text: "",
			encoding: "binary",
			hasBom: false,
			lossy: false,
			binary: true,
			truncated,
			size: stats.size,
		};
	}

	const file = decodeTextFile(truncated ? buffer.subarray(0, MAX_FILE_BYTES) : buffer);
	return {
		path,
		text: file.text,
		encoding: file.encoding,
		hasBom: file.hasBom,
		lossy: file.lossy,
		binary: false,
		truncated,
		size: stats.size,
	};
}

/** 按路径子串搜索文件，供 @ 提及与命令面板使用。 */
export function searchWorkspaceFiles(
	workspace: WorkspaceBoundary,
	rawQuery: string,
	limit: number,
): readonly FileSearchHit[] {
	const query = rawQuery.trim().toLowerCase();
	if (query.length === 0) return [];

	const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
	const hits: FileSearchHit[] = [];
	for (const entry of fileEntries(workspace.root, MAX_SEARCH_ENTRIES)) {
		if (!entry.relative.toLowerCase().includes(query)) continue;
		hits.push({ path: entry.relative, kind: entry.kind });
		if (hits.length >= capped) break;
	}
	return hits;
}

/** 路径必须落在工作区内，且解析软链接之后仍在里面。 */
function resolveInside(workspace: WorkspaceBoundary, input: string): string {
	const resolved = workspace.resolve(input);
	if (!resolved.insideRoot) throw new Error(`Path is outside the workspace: ${input}`);

	const real = resolveRealPath(resolved.absolute);
	if (!isPathInside(resolveRealPath(workspace.root), real)) {
		throw new Error(`Path resolves outside the workspace: ${input}`);
	}
	return real;
}

/** 只读文件开头，避免为一个超大文件分配整份缓冲区。 */
function readPrefix(path: string, bytes: number): Buffer {
	const buffer = Buffer.alloc(bytes);
	const descriptor = openSync(path, "r");
	try {
		const read = readSync(descriptor, buffer, 0, bytes, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(descriptor);
	}
}
