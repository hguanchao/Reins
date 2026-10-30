import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { toAbsolutePath } from "#src/workspace/root.ts";

/**
 * 判断一个绝对路径是否落在某个根之内。
 *
 * 只做一次实现：工作区边界要用它，沙箱也要用它，两处各写一份迟早会在某个细节上分叉
 * （例如不同盘符、名字以 .. 开头的文件），而那正是安全判定最不该出岔子的地方。
 */
export function isPathInside(root: string, absolute: string): boolean {
	const relativePath = relative(root, absolute);
	if (relativePath.length === 0) return true;
	// 不同盘符之间相对路径给不出结果，relative 会直接返回绝对路径
	if (isAbsolute(relativePath)) return false;
	// 以 .. 开头说明跳出了根；单独比较 .. 是为了不误伤名字以 .. 开头的文件
	return relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

interface ResolvedPath {
	/** 归一化后的绝对路径 */
	readonly absolute: string;
	/** 是否落在工作根内 */
	readonly insideRoot: boolean;
}

/**
 * 解析到真实路径；目标不存在时以最近存在的祖先为准。
 *
 * 写文件时目标往往还不存在，直接 realpath 会失败。此时必须解析父目录：一个指向根外的目录
 * 链接就能让「字面路径在根内」的判定失效。解析失败（权限、链接环等）一律向上抛，按拒绝处理。
 *
 * 悬空符号链接要单独处理：目标不存在时 realpath 同样报 ENOENT，若当成「普通缺失文件」把
 * 名字原样拼回去，写操作会跟随链接落到根外。这里改用 lstat 识别最后一段，并用 readlink
 * 把目标解析出来（目标本身还可能不存在，所以递归解析）。
 */
export function resolveRealPath(path: string): string {
	return resolveRealPathWithDepth(path, 0);
}

/** 链接链的解析深度上限：成环时不能无限递归。 */
const MAX_LINK_DEPTH = 32;

function resolveRealPathWithDepth(path: string, depth: number): string {
	if (depth > MAX_LINK_DEPTH) throw new Error(`Too many levels of symbolic links: ${path}`);

	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			const real = realpathSync(current);
			return missing.length === 0 ? real : join(real, ...missing.reverse());
		} catch (error) {
			if (!isNotFound(error)) throw error;
			const linkTarget = danglingLinkTarget(current);
			if (linkTarget !== undefined) {
				// 悬空链接：按它指向的位置继续解析，最终拼回尚未创建的部分
				const resolved = resolveRealPathWithDepth(linkTarget, depth + 1);
				return missing.length === 0 ? resolved : join(resolved, ...missing.reverse());
			}
			const parent = dirname(current);
			if (parent === current) return path;
			missing.push(basename(current));
			current = parent;
		}
	}
}

/**
 * 若该路径本身是悬空符号链接，返回它指向的绝对路径；否则返回 undefined。
 *
 * realpath 对悬空链接报 ENOENT，与「文件不存在」无法区分，必须靠 lstat 再判断一次。
 */
function danglingLinkTarget(path: string): string | undefined {
	try {
		if (!lstatSync(path).isSymbolicLink()) return undefined;
		return resolve(dirname(path), readlinkSync(path));
	} catch {
		// lstat 失败说明确实不存在，或者没有权限；两种都按「不是链接」处理，
		// 交给上层继续按缺失路径解析（权限问题会在 realpath 那一步抛出）。
		return undefined;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * 路径边界。
 *
 * 只回答两个问题：这个路径的绝对形式是什么、它在不在工作根内。是否允许访问由沙箱判定，
 * 两者分开是因为「能不能读到」和「该不该读到」是两件事，混在一起会让错误信息说不清
 * 到底是路径写错了还是被策略挡住了。
 */
export class WorkspaceBoundary {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	resolve(input: string): ResolvedPath {
		const absolute = toAbsolutePath(input, this.root);
		return { absolute, insideRoot: isPathInside(this.root, absolute) };
	}

	/** 相对工作根的显示路径，用于给模型看的输出。根外的路径原样返回。 */
	display(absolute: string): string {
		if (!isPathInside(this.root, absolute)) return absolute;
		const relativePath = relative(this.root, absolute);
		return relativePath.length === 0 ? "." : relativePath.split(sep).join("/");
	}
}
