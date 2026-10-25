import { Session } from "../session/session.ts";
import type { SessionStore } from "../session/store.ts";
import { writeStderr } from "./output.ts";
import { createSession } from "./session-target.ts";

/**
 * 新建本次会话。
 *
 * 会话存储由插件提供，它缺席时新建会话仍可用（只留在内存里），但必须说出来：使用者以为历史
 * 留在磁盘上、事后去找却发现什么都没有，是最难查的一种失败。
 */
export function createSessionFor(workRoot: string, store: SessionStore | undefined): Session {
	if (store === undefined) {
		writeStderr(
			"No session store (session-plugin is disabled or failed to load), this session will not be saved to a file\n",
		);
	}
	return createSession(workRoot, store);
}

/** 会话菜单里的一行标题：控制字符会弄乱面板，统一换成空格。 */
export function sessionTitle(title: string | undefined): string {
	const text = (title ?? "").replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return text.length === 0 ? "(no conversation yet)" : text;
}
