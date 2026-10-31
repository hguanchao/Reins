import { readFileSync } from "node:fs";

/**
 * 版本号取自 package.json;源码即运行产物,因此相对路径在任何安装形态下都成立。
 *
 * 打包形态(桌面安装包)里相对路径必然断裂,构建时由 esbuild define 注入字面量版本,
 * 运行时先认它。这个常量只存在于打包产物里,直接由 Node 跑源码时 typeof 落到 undefined。
 */
declare const REINS_BUNDLED_VERSION: string | undefined;

let cached: string | undefined;

export function readVersion(): string {
	if (cached !== undefined) return cached;
	if (typeof REINS_BUNDLED_VERSION === "string") {
		cached = REINS_BUNDLED_VERSION;
		return cached;
	}

	const url = new URL("../package.json", import.meta.url);
	const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
	if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
		const version = (parsed as { version: unknown }).version;
		if (typeof version === "string") {
			cached = version;
			return cached;
		}
	}
	cached = "unknown";
	return cached;
}
