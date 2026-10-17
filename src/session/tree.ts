import type { SessionEntry } from "./port.ts";

/**
 * 条目树的查询。
 *
 * 条目靠 id/parentId 串成树，因此「某条消息之后是什么」不能靠文件里的行序去猜——行序只是
 * 写入顺序。续聊要的是从根到某个节点的那条路径，分叉要复制这条路径，两件事都走这里，规则
 * 只有一份。
 */

/** 从根到指定条目的路径；目标不在里面时抛错。 */
export function pathTo(entries: readonly SessionEntry[], id: string): readonly SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	if (!byId.has(id)) throw new Error(`Session has no entry ${id}`);

	const path: SessionEntry[] = [];
	let current = byId.get(id);
	while (current !== undefined) {
		path.unshift(current);
		const parentId = current.parentId;
		current = parentId === null ? undefined : byId.get(parentId);
	}
	return path;
}

/**
 * 叶子：没有别的条目挂在它后面的那些条目。
 *
 * 文件里通常只有一条路径，因此叶子就是最后写下的那一条；但格式允许分叉，所以这里不能直接
 * 取最后一行。
 */
export function leavesOf(entries: readonly SessionEntry[]): readonly SessionEntry[] {
	const parents = new Set<string>();
	for (const entry of entries) {
		if (entry.parentId !== null) parents.add(entry.parentId);
	}
	return entries.filter((entry) => !parents.has(entry.id));
}
