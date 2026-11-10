import { mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { configDir } from "#src/config/paths.ts";

/**
 * 独立任务的工作目录。
 *
 * 没有项目的任务不该跟启动目录纠缠：它需要一块只属于自己的空地，删掉任务时整块丢掉也不心疼。
 * 目录放在配置目录的 workspaces 下，跟着 REINS_HOME 一起搬，不写进用户项目里。
 */

const DIR_PREFIX = "standalone-";

const MAX_ATTEMPTS = 20;

/** 独立任务目录的根。 */
export function standaloneRoot(): string {
	return join(configDir(), "workspaces");
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

/** 路径是否落在独立任务根内（根自身也算）。 */
export function isStandalonePath(path: string): boolean {
	const fold = (item: string): string => (process.platform === "win32" ? item.toLowerCase() : item);
	const diff = relative(fold(resolve(standaloneRoot())), fold(resolve(path)));
	if (diff.length === 0) return true;
	return !diff.startsWith("..") && !isAbsolute(diff);
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
