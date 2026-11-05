import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { configDir } from "#src/config/paths.ts";

const CATALOG_FILE = "workspaces.json";

interface CatalogEntry {
	readonly path: string;
	readonly visible: boolean;
}

/** 已登记项目；首次启动时清单为空，损坏时明确报错。 */
export function listWorkspaces(): readonly string[] {
	return readCatalog().filter((entry) => entry.visible).map((entry) => entry.path);
}

/** 包含已从侧栏移除的路径，保证它们的历史任务仍可查找。 */
export function listKnownWorkspaces(): readonly string[] {
	return readCatalog().map((entry) => entry.path);
}

/** 登记一个现存目录；真实路径相同的条目只保留一份。 */
export function registerWorkspace(path: string): string {
	const canonical = canonicalWorkspacePath(path);
	const entries = readCatalog();
	const existing = entries.findIndex((entry) => samePath(entry.path, canonical));
	if (existing >= 0) {
		if (entries[existing]?.visible) return canonical;
		const restored = entries.map((entry, index) =>
			index === existing ? { ...entry, visible: true } : entry,
		);
		writeCatalog(restored);
		return canonical;
	}
	writeCatalog([...entries, { path: canonical, visible: true }]);
	return canonical;
}

/** 从侧栏移除空间但保留会话查找路径；其任务随后作为未归属任务显示。 */
export function unregisterWorkspace(path: string): boolean {
	const entries = readCatalog();
	let changed = false;
	const next = entries.map((entry) => {
		if (!entry.visible || !samePath(entry.path, path)) return entry;
		changed = true;
		return { ...entry, visible: false };
	});
	if (changed) writeCatalog(next);
	return changed;
}

/** 仅返回已登记且可见空间的规范路径。 */
export function registeredWorkspace(path: string): string | undefined {
	const canonical = canonicalWorkspacePath(path);
	return listWorkspaces().find((entry) => samePath(entry, canonical));
}

/** 返回现存目录的真实路径，拒绝文件、缺失目录和链接解析失败。 */
export function canonicalWorkspacePath(path: string): string {
	const canonical = realpathSync(resolve(path));
	if (!statSync(canonical).isDirectory()) throw new Error(`Workspace path is not a directory: ${path}`);
	return canonical;
}

function readCatalog(): readonly CatalogEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(catalogPath(), "utf8"));
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	if (
		!Array.isArray(parsed) ||
		parsed.some(
			(entry) =>
				typeof entry !== "object" ||
				entry === null ||
				typeof (entry as { path?: unknown }).path !== "string" ||
				typeof (entry as { visible?: unknown }).visible !== "boolean",
		)
	) {
		throw new Error("Workspace catalog contains an invalid entry");
	}
	return parsed as CatalogEntry[];
}

function catalogPath(): string {
	return join(configDir(), CATALOG_FILE);
}

function writeCatalog(workspaces: readonly CatalogEntry[]): void {
	mkdirSync(configDir(), { recursive: true });
	writeFileSync(catalogPath(), JSON.stringify(workspaces), "utf8");
}

function samePath(left: string, right: string): boolean {
	const leftPath = resolve(left);
	const rightPath = resolve(right);
	return process.platform === "win32"
		? leftPath.toLowerCase() === rightPath.toLowerCase()
		: leftPath === rightPath;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
