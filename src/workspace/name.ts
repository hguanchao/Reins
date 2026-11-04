import { readFileSync, writeFileSync } from "node:fs";

/**
 * 工作区显示名。
 *
 * 按目录路径键存一张表：重命名只改这张表，不碰磁盘上的目录名——目录属于使用者，
 * 界面上的叫法属于界面。表本身是一个小 JSON 文件，位置由调用方给（桌面壳放用户数据目录）。
 */

/** 名字长度上限：够容下项目全名，又不至于把侧栏那点宽度撑坏。 */
export const WORKSPACE_NAME_LIMIT = 60;

/**
 * 读整张表。
 *
 * 文件缺失或坏掉时都当空表：一个坏文件不该让「换个叫法」这种小事整体失效，
 * 库里没有名字时界面回落到目录名，仍然可用。
 */
export function readWorkspaceNames(file: string): Readonly<Record<string, string>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const entries = Object.entries(parsed as Record<string, unknown>).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return Object.fromEntries(entries);
}

/** 取某个目录的显示名；没改过名时为 undefined，由界面回落到目录名。 */
export function workspaceNameOf(file: string, path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	return readWorkspaceNames(file)[path];
}

/**
 * 写一条名字，返回是否落盘。
 *
 * 名字去掉首尾空白后为空、或超过上限时直接拒绝：库里存一个空白名字，界面只会显示成
 * 「没有名字」，不如当场说不。写失败不算异常，调用方按「没改成」处理。
 */
export function writeWorkspaceName(file: string, path: string, name: string): boolean {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > WORKSPACE_NAME_LIMIT) return false;
	try {
		writeFileSync(file, JSON.stringify({ ...readWorkspaceNames(file), [path]: trimmed }));
		return true;
	} catch {
		return false;
	}
}
