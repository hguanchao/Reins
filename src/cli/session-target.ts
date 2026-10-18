import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { sessionsDir } from "../config/paths.ts";
import { Session } from "../session/session.ts";
import type { SessionStore } from "../session/store.ts";

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
 * 会话文件路径。
 *
 * 文件名里带创建时间，便于按时间找人；后缀是短随机串，避免同一秒内启动两次时撞名。
 */
export function sessionFilePath(workRoot: string): string {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	return join(sessionsDir(workRoot), `${stamp}_${randomBytes(4).toString("hex")}.jsonl`);
}
