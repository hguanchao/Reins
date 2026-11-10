import { mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { isStandaloneSessionPath, sessionsRootDir } from "#src/config/paths.ts";

/**
 * 独立任务的工作目录。
 *
 * 没有项目的任务不该跟启动目录纠缠：它需要一块只属于自己的空地，删掉任务时整块丢掉也不心疼。
 * 目录直接放在 sessions 下，名称以 standalone- 开头，会话 JSONL 也写在该目录中。
 */

const DIR_PREFIX = "standalone-";

const MAX_ATTEMPTS = 20;

/** 独立任务与 Reins 自建项目目录的根。 */
export function standaloneRoot(): string {
	return sessionsRootDir();
}

/** 新版自管目录：只扫描 sessions 根目录下以 standalone- 开头的直接子目录。 */
export function listStandaloneDirs(): readonly string[] {
	let names: string[];
	try {
		names = readdirSync(standaloneRoot(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(DIR_PREFIX))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	return names.map((name) => join(standaloneRoot(), name));
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

/** 目录名取创建时刻，同时给出给人看的短标签。 */
function stamp(now: Date): { readonly slug: string; readonly label: string } {
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return { slug: `${DIR_PREFIX}${date}-${time}`, label: `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}` };
}

/**
 * 建一个新的独立任务目录。
 *
 * 同一秒内连续新建会撞名，靠后缀递增让开而不是覆盖：撞名时直接 mkdir 会拿到已有目录，
 * 两个任务就会共用一块地。
 */
export function createStandaloneDir(now: Date = new Date()): { readonly path: string; readonly label: string } {
	const root = standaloneRoot();
	mkdirSync(root, { recursive: true });
	const { slug, label } = stamp(now);
	for (let index = 1; index <= MAX_ATTEMPTS; index += 1) {
		const path = join(root, index === 1 ? slug : `${slug}-${index}`);
		try {
			mkdirSync(path);
			return { path, label };
		} catch {
			// 已存在则试下一个后缀
		}
	}
	throw new Error("无法创建独立任务目录");
}

/** 路径是否指向新版 standalone 子目录。 */
export function isStandalonePath(path: string): boolean {
	const normalized = resolve(path);
	if (normalized === resolve(standaloneRoot())) return true;
	if (!isStandaloneSessionPath(normalized)) return false;
	return relative(resolve(standaloneRoot()), normalized).startsWith(DIR_PREFIX);
}

/** 回收一个独立任务目录：只在它确实空着时删除，有内容就原样留着。 */
export function releaseStandaloneDir(path: string): boolean {
	if (path.length === 0 || !isStandalonePath(path)) return false;
	try {
		if (readdirSync(path).length > 0) return false;
		rmdirSync(path);
		return true;
	} catch {
		return false;
	}
}
