import { readFileSync } from "node:fs";

/**
 * 版本号取自 package.json；源码即运行产物，因此相对路径在任何安装形态下都成立。
 *
 * 结果缓存：版本在一次进程生命周期内不会变化，而它会被请求头、页脚和插件元信息多次读取。
 */
let cached: string | undefined;

export function readVersion(): string {
	if (cached !== undefined) return cached;

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
