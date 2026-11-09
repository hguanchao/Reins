import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";

import { sessionDirectories, sessionsDir } from "#src/config/paths.ts";
import { Session } from "#src/session/session.ts";
import type { SessionListing, SessionStore } from "#src/session/store.ts";

/**
 * 新建一个会话。
 *
 * 会话文件要等到真正写入时才建立：启动后只问一句、或直接出错退出，不该在磁盘上留下空会话。
 * 没有会话仓库时退回内存会话，这件事由调用方负责告诉使用者。
 */
export function createSession(
	workRoot: string,
	store: SessionStore | undefined,
	workspacePath: string | null = null,
): Session {
	const id = randomBytes(8).toString("hex");
	if (store === undefined) return new Session({ id, cwd: workRoot, workspacePath, file: null });

	const file = sessionFilePath(workRoot);
	return new Session({
		id,
		cwd: workRoot,
		workspacePath,
		file,
		writer: store.create({ id, cwd: workRoot, workspacePath, file }),
	});
}

/**
 * 按标识接续一个既有会话。
 *
 * 标识写在会话文件头部，文件名只是创建时的快照，不能从标识反推出路径，所以先查清单。
 * 目录名规则改过一次，旧会话留在旧目录里：候选目录按优先级逐个查，升级之后历史仍然找得到。
 */
export function resumeSession(workRoot: string, id: string, store: SessionStore): Session {
	const directories = sessionDirectories(workRoot);
	for (const directory of directories) {
		const listing = store.list(directory).find((item) => item.id === id);
		if (listing !== undefined) return Session.open(listing.file, store);
	}
	throw new Error(`Session ${id} not found in ${directories.join(" or ")}`);
}

/** 列出这个工作区的全部会话；新旧目录的会话合并成一份清单。 */
export function listSessions(workRoot: string, store: SessionStore): readonly SessionListing[] {
	const seen = new Set<string>();
	const listings: SessionListing[] = [];
	for (const directory of sessionDirectories(workRoot)) {
		for (const listing of store.list(directory)) {
			if (seen.has(listing.id)) continue;
			seen.add(listing.id);
			listings.push(listing);
		}
	}
	return listings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** 跨多个已登记工作区列出会话；同一会话若被多处存储，只展示第一次找到的副本。 */
export function listSessionsAcross(
	workRoots: readonly string[],
	store: SessionStore,
): readonly SessionListing[] {
	const seen = new Set<string>();
	const listings: SessionListing[] = [];
	for (const workRoot of workRoots) {
		for (const listing of listSessions(workRoot, store)) {
			if (seen.has(listing.id)) continue;
			seen.add(listing.id);
			listings.push(listing);
		}
	}
	return listings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** 退出全屏界面后留在主屏上的命令，使用者也据此回到同一个会话。 */
export function resumeCommand(id: string): string {
	return `reins --resume ${id}`;
}

/** 归档目录:挂在每个会话目录下的 archived 子目录;清单只认 .jsonl 文件,不会把它当会话扫出来。 */
function archivedDirectory(directory: string): string {
	return join(directory, "archived");
}

/** 列出已归档的会话;新旧目录的归档合并成一份清单,排序规则同活动清单。 */
export function listArchivedSessions(workRoot: string, store: SessionStore): readonly SessionListing[] {
	const seen = new Set<string>();
	const listings: SessionListing[] = [];
	for (const directory of sessionDirectories(workRoot)) {
		const archived = archivedDirectory(directory);
		if (!existsSync(archived)) continue;
		for (const listing of store.list(archived)) {
			if (seen.has(listing.id)) continue;
			seen.add(listing.id);
			listings.push(listing);
		}
	}
	return listings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** 跨多个已登记工作区列出已归档会话。 */
export function listArchivedSessionsAcross(
	workRoots: readonly string[],
	store: SessionStore,
): readonly SessionListing[] {
	const seen = new Set<string>();
	const listings: SessionListing[] = [];
	for (const workRoot of workRoots) {
		for (const listing of listArchivedSessions(workRoot, store)) {
			if (seen.has(listing.id)) continue;
			seen.add(listing.id);
			listings.push(listing);
		}
	}
	return listings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * 批量删除会话,返回实际删除的个数。
 *
 * skip 里的会话(当前正在用的那个)原地跳过:删掉自己脚下正在写的会话文件,回合写到一半
 * 就没有落点了。
 */
export function deleteSessions(
	workRoot: string,
	store: SessionStore,
	ids: readonly string[],
	skip: readonly string[],
): number {
	let deleted = 0;
	for (const directory of deletableDirectories(workRoot)) {
		for (const listing of store.list(directory)) {
			if (!ids.includes(listing.id) || skip.includes(listing.id)) continue;
			rmSync(listing.file, { force: true });
			deleted += 1;
		}
	}
	return deleted;
}

/**
 * 删除要扫的目录:活动目录之外还有归档目录。
 *
 * 界面上的「永久删除」和「删除项目」说的都是这些记录,只扫活动目录会留下删不掉的残档。
 */
function deletableDirectories(workRoot: string): readonly string[] {
	return sessionDirectories(workRoot).flatMap((directory) => {
		const archived = archivedDirectory(directory);
		return existsSync(archived) ? [directory, archived] : [directory];
	});
}

/** 批量归档:会话文件挪进所在目录的 archived 子目录,返回实际归档的个数。 */
export function archiveSessions(
	workRoot: string,
	store: SessionStore,
	ids: readonly string[],
	skip: readonly string[],
): number {
	let archived = 0;
	for (const directory of sessionDirectories(workRoot)) {
		const target = archivedDirectory(directory);
		for (const listing of store.list(directory)) {
			if (!ids.includes(listing.id) || skip.includes(listing.id)) continue;
			mkdirSync(target, { recursive: true });
			renameSync(listing.file, join(target, basename(listing.file)));
			archived += 1;
		}
	}
	return archived;
}

/** 批量恢复:归档文件挪回活动目录,返回实际恢复的个数。 */
export function restoreSessions(workRoot: string, store: SessionStore, ids: readonly string[]): number {
	let restored = 0;
	for (const directory of sessionDirectories(workRoot)) {
		const archived = archivedDirectory(directory);
		if (!existsSync(archived)) continue;
		for (const listing of store.list(archived)) {
			if (!ids.includes(listing.id)) continue;
			renameSync(listing.file, join(directory, basename(listing.file)));
			restored += 1;
		}
	}
	return restored;
}

/** 将批量会话操作应用到各已登记工作区。 */
export function deleteSessionsAcross(
	workRoots: readonly string[],
	store: SessionStore,
	ids: readonly string[],
	skip: readonly string[],
): number {
	return workRoots.reduce((total, workRoot) => total + deleteSessions(workRoot, store, ids, skip), 0);
}

export function archiveSessionsAcross(
	workRoots: readonly string[],
	store: SessionStore,
	ids: readonly string[],
	skip: readonly string[],
): number {
	return workRoots.reduce((total, workRoot) => total + archiveSessions(workRoot, store, ids, skip), 0);
}

export function restoreSessionsAcross(
	workRoots: readonly string[],
	store: SessionStore,
	ids: readonly string[],
): number {
	return workRoots.reduce((total, workRoot) => total + restoreSessions(workRoot, store, ids), 0);
}

/**
 * 会话归属的目录：归属标记优先，旧会话没有标记时退回 cwd。
 *
 * 项目从侧栏移除后，界面会把归属抹成 null 以便任务显示为「未归属」；但内核删除项目时
 * 仍要认出这些文件属于哪个目录，否则会留下扫不到也删不掉的孤儿会话。
 */
export function sessionOwner(item: {
	readonly workspacePath?: string | null;
	readonly cwd?: string;
}): string | null {
	const owner = item.workspacePath ?? item.cwd;
	return typeof owner === "string" && owner.length > 0 ? owner : null;
}

/**
 * 从会话的当前末尾分叉出一个新会话。
 *
 * 只复制对话路径，不碰工作区文件；原会话保持原样，两个会话之后各写各的。
 */
export function forkSession(source: Session, workRoot: string, store: SessionStore): Session {
	return Session.fork(source, {
		id: randomBytes(8).toString("hex"),
		cwd: workRoot,
		workspacePath: source.workspacePath,
		file: sessionFilePath(workRoot),
		store,
	});
}

/**
 * 会话文件路径。
 *
 * 文件名里带创建时间，便于按时间找人；后缀是短随机串，避免同一秒内启动两次时撞名。
 */
function sessionFilePath(workRoot: string): string {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	return join(sessionsDir(workRoot), `${stamp}_${randomBytes(4).toString("hex")}.jsonl`);
}
