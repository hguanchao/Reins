import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ConfigError } from "../config/config-error.ts";
import { configFilePath, projectConfigFilePath, projectDirPath } from "../config/paths.ts";
import { TomlDocument } from "../config/toml/index.ts";

/**
 * 工作区信任。
 *
 * 信任决定的是「要不要读取这个工作区自带的配置」，不是「能不能访问这个工作区」。前者是启动
 * 阶段一次性的事，后者由沙箱负责——把两件事混在一起，会让人以为「不信任」等于「读不到文件」，
 * 而实际上它只意味着项目里的配置不会生效。
 *
 * 拒绝信任时项目配置整体跳过，而不是逐项挑选：从不受信任的目录里读一部分配置，比完全不读
 * 更难解释清楚到底生效了什么。
 */

export interface ProjectResources {
	/** 目录本身 */
	readonly directory: string;
	/** 需要信任才能读取的具体文件 */
	readonly files: readonly string[];
}

/** 找出工作区里需要信任才能读取的东西。没有就不必问。 */
export function findProjectResources(root: string): ProjectResources {
	const directory = projectDirPath(root);
	const candidates = [projectConfigFilePath(root), join(directory, "models.json")];
	// 只列出确有其物的文件：让使用者为不存在的东西做决定没有意义
	const files = candidates.filter((path) => existsSync(path) && statSync(path).isFile());
	return { directory, files };
}

export interface TrustDecision {
	readonly trusted: boolean;
	/** 结论来自哪里，用于告诉使用者为什么是这个结果 */
	readonly source: "flag" | "saved" | "default" | "none";
}

/**
 * 在已记录的信任清单里找匹配项。
 *
 * 从工作区往上找最近的记录：在项目根信任过之后，它下面的子目录不必再问一次。反过来不成立
 * ——信任一个子目录不代表信任整棵树。
 */
export function findSavedDecision(trustedRoots: readonly string[], root: string): boolean | undefined {
	let current = resolve(root);
	for (;;) {
		if (trustedRoots.some((entry) => samePath(entry, current))) return true;

		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * 定下这次运行的信任结果。
 *
 * 链条是：命令行给出的一票 → 已记录的清单 → 没有人可问时按不信任处理。默认不信任是刻意的：
 * 从别处拿来的目录默认让它的配置生效，等于让一个目录在没人同意的情况下改变程序的行为。
 */
export function resolveTrust(options: {
	readonly root: string;
	/** 命令行给出的结论 */
	readonly override: boolean | undefined;
	readonly trustedRoots: readonly string[];
	/** 有交互界面时才会去问 */
	readonly ask: (() => boolean) | undefined;
	readonly hasProtectedResources: boolean;
}): TrustDecision {
	if (!options.hasProtectedResources) return { trusted: false, source: "none" };
	if (options.override !== undefined) return { trusted: options.override, source: "flag" };

	const saved = findSavedDecision(options.trustedRoots, options.root);
	if (saved !== undefined) return { trusted: saved, source: "saved" };

	if (options.ask !== undefined) return { trusted: options.ask(), source: "default" };
	return { trusted: false, source: "default" };
}

/**
 * 把信任结论写回用户配置。
 *
 * 项目配置本身不能声明自己受信任——否则「不受信任的目录无法影响程序行为」这条就形同虚设。
 * 所以清单只写在用户级配置里。
 */
export function recordTrust(root: string, trusted: boolean): void {
	const file = configFilePath();
	const source = existsSync(file) ? readFileSync(file, "utf8") : "";
	const document = new TomlDocument(source);
	const canonical = resolve(root);

	const current = readTrustedRoots(document);
	const next = trusted
		? [...current.filter((entry) => !samePath(entry, canonical)), canonical]
		: current.filter((entry) => !samePath(entry, canonical));

	try {
		mkdirSync(dirname(file), { recursive: true });
		// 定点回写：使用者写在配置文件里的注释与排版原样保留
		document.set(["plugins", "trusted"], next);
		writeFileSync(file, document.source, "utf8");
	} catch (error) {
		throw new ConfigError(
			`写入信任清单失败：${error instanceof Error ? error.message : String(error)}`,
			{ file },
		);
	}
}

/** 读已记录的信任清单。 */
export function readTrustedRoots(document: TomlDocument): readonly string[] {
	const value = document.get(["plugins", "trusted"]);
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

/** 路径比较统一大小写差异：Windows 上同一个目录可以有多种写法。 */
function samePath(left: string, right: string): boolean {
	const normalize = (path: string): string => {
		const resolved = resolve(path);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}
