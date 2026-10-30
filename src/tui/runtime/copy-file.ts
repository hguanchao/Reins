import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configDir } from "#src/config/paths.ts";

/**
 * 复制内容的落盘兜底。
 *
 * 剪贴板是两条腿走路：先调系统命令，再退到 OSC 52。两条都可能悄悄失败——容器里没有
 * xclip、终端忽略 OSC 52 时，使用者只会看到一句「复制失败」，而刚才那段内容再也拿不回来。
 * 因此把文本写到固定文件里，提示里给出路径，至少还能从文件里捡回来。
 */

/** 兜底文件位置；REINS_COPY_FILE 可覆盖，便于多套配置或测试隔离。 */
export function copyFallbackPath(): string {
	const override = process.env["REINS_COPY_FILE"];
	if (override !== undefined && override.length > 0) return override;
	return join(configDir(), "last-copy.txt");
}

/** 写兜底文件；成功返回路径，失败返回 undefined（写不进去时不再制造第二个错误）。 */
export async function saveCopyFallback(text: string): Promise<string | undefined> {
	const path = copyFallbackPath();
	try {
		await mkdir(dirname(path), { recursive: true });
		// 复制的内容可能含密钥、路径，权限收到本人可读
		await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

/** 状态行里显示短路径：主目录下的文件写成 `~/…`，长路径不挤掉别的提示。 */
export function shortPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	return path.startsWith(`${home}\\`) || path.startsWith(`${home}/`)
		? `~${path.slice(home.length)}`
		: path;
}
