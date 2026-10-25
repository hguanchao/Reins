/**
 * 隔离后端与启动自检共用的 shell 引用。
 *
 * 单引号包裹、内部单引号先闭合再转义，是 POSIX shell 唯一可靠的引用方式；Windows 使用
 * 双引号并把内部双引号成对写出。安全相关的引用规则只留这一份，改一处不会漏另一处。
 */
export function quoteForShell(text: string): string {
	if (process.platform === "win32") return `"${text.replaceAll('"', '""')}"`;
	return `'${text.replaceAll("'", "'\\''")}'`;
}
