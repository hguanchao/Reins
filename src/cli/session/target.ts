import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { sessionDirectories, sessionsDir } from "../../config/paths.ts";
import { Session } from "../../session/session.ts";
import type { SessionListing, SessionStore } from "../../session/store.ts";

/**
 * 新建一个会话。
 *
 * 会话文件要等到真正写入时才建立：启动后只问一句、或直接出错退出，不该在磁盘上留下空会话。
 * 没有会话仓库时退回内存会话，这件事由调用方负责告诉使用者。
 */
export function createSession(workRoot: string, store: SessionStore | undefined): Session {
	const id = randomBytes(8).toString("hex");
	if (store === undefined) return new Session({ id, cwd: workRoot, file: null });

	const file = sessionFilePath(workRoot);
	return new Session({ id, cwd: workRoot, file, writer: store.create({ id, cwd: workRoot, file }) });
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

/** 退出全屏界面后留在主屏上的命令，使用者也据此回到同一个会话。 */
export function resumeCommand(id: string): string {
	return `reins --resume ${id}`;
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
