import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { isStandaloneSessionPath, sessionsDir, sessionsRootDir, workspacesDir } from "#src/config/paths.ts";
import { WORKSPACE_NAME_LIMIT } from "#src/workspace/name.ts";
import { isStandalonePath, listStandaloneDirs } from "#src/workspace/standalone.ts";

const REGISTRY_FILE_NAME = "registry.json";

export type WorkspaceType = "created" | "registered";

interface CatalogEntry {
	readonly path: string;
	readonly workspaceType: WorkspaceType;
	readonly displayName?: string;
	readonly visible: boolean;
	readonly order: number;
}

/** 已登记项目；首次启动时清单为空，损坏时明确报错。 */
export function listWorkspaces(): readonly string[] {
	return readCatalog().filter((entry) => entry.visible).map((entry) => entry.path);
}

/** 包含已从侧栏移除的路径，保证它们的历史任务仍可查找。 */
export function listKnownWorkspaces(): readonly string[] {
	return readCatalog().map((entry) => entry.path);
}

/** 工作区的自定义显示名；未改名时交给界面回落到目录名。 */
export function workspaceDisplayName(path: string): string | undefined {
	return readCatalog().find((entry) => samePath(entry.path, path))?.displayName;
}

/** 返回登记的工作区类别，用来区分自建项目与未绑定任务目录。 */
export function workspaceTypeOf(path: string): WorkspaceType | undefined {
	return readCatalog().find((entry) => samePath(entry.path, path))?.workspaceType;
}

/** 登记一个现存目录；真实路径相同的条目只保留一份。 */
export function registerWorkspace(path: string, type?: WorkspaceType, displayName?: string): string {
	const canonical = canonicalWorkspacePath(path);
	const entries = readCatalog();
	const existing = entries.find((entry) => samePath(entry.path, canonical));
	if (existing !== undefined) {
		const workspaceType = type ?? existing.workspaceType;
		const updated = {
			...existing,
			workspaceType,
			...(displayName === undefined ? {} : { displayName }),
			visible: true,
		};
		if (
			existing.visible &&
			existing.workspaceType === updated.workspaceType &&
			existing.displayName === updated.displayName
		) {
			return canonical;
		}
		writeEntry(updated);
		return canonical;
	}
	writeEntry({
		path: canonical,
		workspaceType: type ?? inferWorkspaceType(canonical),
		...(displayName === undefined ? {} : { displayName }),
		visible: true,
		order: nextOrder(entries),
	});
	return canonical;
}

/** 从侧栏移除空间但保留会话查找路径；其任务随后作为未归属任务显示。 */
export function unregisterWorkspace(path: string): boolean {
	const existing = readCatalog().find((entry) => entry.visible && samePath(entry.path, path));
	if (existing === undefined) return false;
	writeEntry({ ...existing, visible: false });
	return true;
}

/** 删除一个项目：登记记录连同隐藏记录一起去掉。 */
export function dropWorkspace(path: string): boolean {
	const entries = readCatalog();
	const existing = entries.find((entry) => samePath(entry.path, path));
	if (existing === undefined) return false;
	writeRegistry(entries.filter((entry) => !samePath(entry.path, existing.path)));
	return true;
}

/** 更新工作区显示名；名称无效、项目不可见或写入失败时返回 false。 */
export function renameWorkspace(path: string, name: string): boolean {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > WORKSPACE_NAME_LIMIT) return false;
	try {
		const canonical = canonicalWorkspacePath(path);
		const existing = readCatalog().find((entry) => entry.visible && samePath(entry.path, canonical));
		if (existing === undefined) return false;
		if (existing.displayName === trimmed) return true;
		writeEntry({ ...existing, displayName: trimmed });
		return true;
	} catch {
		return false;
	}
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
	return readRegistry();
}

function readRegistry(): readonly CatalogEntry[] {
	let contents: string;
	try {
		contents = readFileSync(registryFile(), "utf8");
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		throw new Error("Workspace registry contains invalid JSON");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { version?: unknown }).version !== 1 ||
		!Array.isArray((parsed as { workspaces?: unknown }).workspaces)
	) {
		throw new Error("Workspace registry contains an invalid snapshot");
	}
	const entries = new Map<string, CatalogEntry>();
	for (const value of (parsed as { workspaces: unknown[] }).workspaces) {
		const entry = parseCatalogEntry(value);
		entries.set(foldPath(entry.path), entry);
	}
	return sortEntries([...entries.values()]);
}

function parseCatalogEntry(value: unknown): CatalogEntry {
	if (typeof value !== "object" || value === null) {
		throw new Error("Workspace registry contains an invalid entry");
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record["path"] !== "string" ||
		(record["workspaceType"] !== "created" && record["workspaceType"] !== "registered") ||
		typeof record["visible"] !== "boolean" ||
		!Number.isSafeInteger(record["order"]) ||
		(record["order"] as number) < 0 ||
		("displayName" in record && typeof record["displayName"] !== "string")
	) {
		throw new Error("Workspace registry contains an invalid entry");
	}
	return {
		path: record["path"],
		workspaceType: record["workspaceType"],
		...(typeof record["displayName"] === "string" ? { displayName: record["displayName"] } : {}),
		visible: record["visible"],
		order: record["order"] as number,
	};
}

function writeEntry(entry: CatalogEntry): void {
	const entries = new Map(readRegistry().map((item) => [foldPath(item.path), item]));
	entries.set(foldPath(entry.path), entry);
	writeRegistry([...entries.values()]);
}

function writeRegistry(entries: readonly CatalogEntry[]): void {
	mkdirSync(workspacesDir(), { recursive: true });
	const file = registryFile();
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ version: 1, workspaces: sortEntries(entries) }, null, 2)}\n`, "utf8");
	renameSync(temporary, file);
}

function sortEntries(entries: readonly CatalogEntry[]): readonly CatalogEntry[] {
	return [...entries].sort((left, right) => left.order - right.order || left.path.localeCompare(right.path));
}

function registryFile(): string {
	return join(workspacesDir(), REGISTRY_FILE_NAME);
}

function nextOrder(entries: readonly CatalogEntry[]): number {
	return entries.reduce((maximum, entry) => Math.max(maximum, entry.order), -1) + 1;
}

function inferWorkspaceType(path: string): WorkspaceType {
	return isStandaloneSessionPath(path) ? "created" : "registered";
}

function samePath(left: string, right: string): boolean {
	return foldPath(left) === foldPath(right);
}

function foldPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** 注册表损坏或缺失时，从新版会话目录重建可恢复的路径。 */
export function rebuildCatalogFromSessions(fallbackWorkspace?: string): number {
	let entries: readonly CatalogEntry[];
	try {
		entries = readCatalog();
	} catch {
		entries = [];
		removeFileIfPresent(registryFile());
	}

	const known = new Set(entries.map((entry) => foldPath(entry.path)));
	let order = nextOrder(entries);
	let added = 0;

	let excluded: string | undefined;
	if (fallbackWorkspace !== undefined) {
		try {
			excluded = canonicalWorkspacePath(fallbackWorkspace);
		} catch {
			excluded = undefined;
		}
	}
	for (const found of createdProjectSessions()) {
		const key = foldPath(found.path);
		if (known.has(key)) continue;
		known.add(key);
		writeEntry({ path: found.path, workspaceType: "created", visible: found.active, order });
		order += 1;
		added += 1;
	}
	for (const directory of sessionDirectoriesUnderRoot()) {
		const found = readSessionDirectory(directory);
		if (found === undefined) continue;
		if (isStandalonePath(found.path)) continue;
		if (excluded !== undefined && samePath(found.path, excluded)) continue;
		const key = foldPath(found.path);
		if (known.has(key)) continue;
		known.add(key);
		writeEntry({ path: found.path, workspaceType: "registered", visible: found.active, order });
		order += 1;
		added += 1;
	}
	return added;
}

function createdProjectSessions(): readonly { readonly path: string; readonly active: boolean }[] {
	const records: { readonly path: string; readonly active: boolean }[] = [];
	for (const project of listStandaloneDirs()) {
		const found = readSessionDirectory(sessionsDir(project));
		if (found !== undefined && samePath(found.path, project)) records.push(found);
	}
	return records;
}

function sessionDirectoriesUnderRoot(): readonly string[] {
	let names: readonly string[];
	try {
		names = readdirSync(sessionsRootDir(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("standalone-") && /[0-9a-f]{16}$/i.test(entry.name))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	return names.map((name) => join(sessionsRootDir(), name));
}

/** 只从新版会话头的 workspacePath 恢复工作区归属。 */
function readSessionDirectory(directory: string): { readonly path: string; readonly active: boolean } | undefined {
	let names: readonly string[];
	try {
		names = readdirSync(directory);
	} catch {
		return undefined;
	}
	const active = names.some((name) => name.endsWith(".jsonl"));
	if (!active) {
		let archived: readonly string[];
		try {
			archived = readdirSync(join(directory, "archived"));
		} catch {
			return undefined;
		}
		if (!archived.some((name) => name.endsWith(".jsonl"))) return undefined;
	}
	const name = names.find((item) => item.endsWith(".jsonl"));
	const sample = name === undefined ? firstJsonl(join(directory, "archived")) : join(directory, name);
	if (sample === undefined) return undefined;
	const path = sessionHeaderWorkspacePath(sample);
	if (path === undefined) return undefined;
	try {
		return { path: canonicalWorkspacePath(path), active };
	} catch {
		return undefined;
	}
}

function firstJsonl(directory: string): string | undefined {
	try {
		return readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(directory, name))[0];
	} catch {
		return undefined;
	}
}

/** 会话文件首行是元信息，只读它的开头就够，不整份载入。 */
function sessionHeaderWorkspacePath(file: string): string | undefined {
	let handle: number | undefined;
	try {
		handle = openSync(file, "r");
		const buffer = Buffer.alloc(4096);
		const read = readSync(handle, buffer, 0, buffer.length, 0);
		const line = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as { workspacePath?: unknown };
		return typeof record.workspacePath === "string" && record.workspacePath.length > 0
			? record.workspacePath
			: undefined;
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) closeSync(handle);
	}
}

function removeFileIfPresent(file: string): void {
	try {
		unlinkSync(file);
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}
