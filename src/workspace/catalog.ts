import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
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

/**
 * 删除一个项目：清单里的条目连同隐藏记录一起去掉。
 *
 * 保留隐藏记录是为了让「从侧栏移除」之后的历史任务还能查到；项目是连着任务一起删掉的，
 * 再留着这条路径只会让会话扫描指向一个已经没有记录的目录。
 */
export function dropWorkspace(path: string): boolean {
	const entries = readCatalog();
	const next = entries.filter((entry) => !samePath(entry.path, path));
	const changed = next.length !== entries.length;
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

function foldPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

/**
 * 清单是可重建的缓存，不是唯一真相。
 *
 * 会话目录名带哈希，反推不出路径，因此扫描必须先知道根——登记丢了（文件被删、写坏）
 * 历史任务就再也扫不到。整份清单丢了只能靠会话文件头里的 cwd 找回来。
 *
 * 只补清单里没有的路径：已经有条目的（哪怕是被「从侧栏移除」置成隐藏的）一律不动，
 * 免得把使用者藏起来的项目又翻出来。返回补上的条数。
 *
 * fallbackWorkspace 是桌面启动的落地目录：它只作 cwd，不是用户项目，
 * 哪怕里面有活动会话也不补进清单，否则侧栏会凭空多出默认项目。
 */
export function rebuildCatalogFromSessions(fallbackWorkspace?: string): number {
	let entries: readonly CatalogEntry[];
	let broken = false;
	try {
		entries = readCatalog();
	} catch {
		// 清单损坏时按空清单重建，相当于自愈；留着坏文件只会一直报错
		entries = [];
		broken = true;
	}
	const base = join(configDir(), "sessions");
	let names: readonly string[];
	try {
		names = readdirSync(base, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return 0;
	}
	const known = new Set(entries.map((entry) => foldPath(entry.path)));
	// 落地目录与扫描结果都统一成真实路径再比，路径写法不同也认得出来；
	// 目录已不存在时会话不可能落在里面，无需排除
	let excluded: string | undefined;
	if (fallbackWorkspace !== undefined) {
		try {
			excluded = canonicalWorkspacePath(fallbackWorkspace);
		} catch {
			excluded = undefined;
		}
	}
	const next: CatalogEntry[] = [...entries];
	for (const name of names) {
		const found = readSessionDirectory(join(base, name));
		if (found === undefined) continue;
		if (excluded !== undefined && samePath(found.path, excluded)) continue;
		const key = foldPath(found.path);
		if (known.has(key)) continue;
		known.add(key);
		next.push({ path: found.path, visible: found.active });
	}
	const added = next.length - entries.length;
	// 坏文件即使一条都补不出来也要覆写，否则后续读取还会在同一个地方炸
	if (added > 0 || broken) writeCatalog(next);
	return added;
}

/**
 * 从一个会话目录里读出它属于哪个工作根。
 *
 * 目录里一个会话都没有就无从判断，直接跳过。只有归档会话的目录补进来时先隐藏：
 * 它们不该占着侧栏，但路径仍要留着，否则归档任务再也恢复不了。
 */
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
	const cwd = sessionHeaderCwd(sample);
	if (cwd === undefined) return undefined;
	try {
		// 会话记的是旧路径写法，登记统一用真实路径，否则同一目录会因写法不同存两条
		return { path: canonicalWorkspacePath(cwd), active };
	} catch {
		// 目录已经不存在，留着条目也没有意义
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
function sessionHeaderCwd(file: string): string | undefined {
	let handle: number | undefined;
	try {
		handle = openSync(file, "r");
		const buffer = Buffer.alloc(1024);
		const read = readSync(handle, buffer, 0, buffer.length, 0);
		const line = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const cwd = (parsed as { cwd?: unknown }).cwd;
		return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) closeSync(handle);
	}
}
