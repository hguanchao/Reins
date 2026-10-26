/**
 * 隔离后端与启动自检共用的 shell 引用。
 *
 * 一律按 POSIX 规则引用：单引号包裹，内部单引号先闭合再转义。这是 POSIX shell 唯一可靠的
 * 引用方式。
 *
 * 不按平台分支：本项目在 Windows 上用的也是 Git Bash（见 shell 选择），cmd 风格的
 * `"..."` 在 bash 里既不阻止 `$(...)`、反引号与 `$VAR` 展开，也不处理 `%VAR%`，
 * 按平台分开写只会让 Windows 分支成为一个看起来安全、实际更弱的分支。
 */
export function quoteForShell(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
